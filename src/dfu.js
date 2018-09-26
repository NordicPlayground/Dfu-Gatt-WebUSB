/*global Module */
const _ = require('underscore');
const JSZip = require('jszip');
const EventEmitter = require('events');

const { BleTransport } = require('./dfu/transport');

const logLevel = require('./util/logLevel');
const { createError, ErrorCode } = require('./dfu/dfuConstants');
const { descriptorHandleToCharacteristic, GattcDescriptor, GattcService, GattcCharacteristic, characteristicHandleToService, uuidToCharacteristic } = require('./sdk/src/js/gattc');

const { sd_rpc_log_severity_t, sd_rpc_app_status_t, NRF_SUCCESS, BLE_GAP_EVT_CONNECTED, BLE_GATTC_EVT_READ_RSP, BLE_GAP_EVT_ADV_REPORT, BLE_GATTC_EVT_PRIM_SRVC_DISC_RSP, BLE_GATTC_EVT_CHAR_DISC_RSP, BLE_GATTC_EVT_DESC_DISC_RSP, BLE_GATTC_EVT_WRITE_RSP, BLE_GAP_EVT_CONN_PARAM_UPDATE_REQUEST,
BLE_GAP_EVT_SEC_PARAMS_REQUEST, BLE_GATTC_EVT_HVX, BLE_GATTC_EVT_EXCHANGE_MTU_RSP, BLE_EVT_TX_COMPLETE, BLE_GAP_EVT_DISCONNECTED } = require('./sdk/src/js/sd_rpc_types');

const { sd_ble_gattc_hv_confirm } = require('./sdk/src/js/ble_impl/ble_gattc_impl');


const DfuSpeedometer = require('./dfu/dfuSpeedometer');

const { ble_event_struct } = require('./sdk/src/js/bindings/bleEvtStruct');
const dfuEvent = new EventEmitter();

const DfuState = Object.freeze({
    READY: 0,
    IN_PROGRESS: 1,
    ABORTING: 2,
});

class Dfu extends EventEmitter {
    constructor(parameters, bleCfgTag) {
        super();
        this.adapter = parameters.adapter;
        this.transportParameters = parameters;
        this._transport = null;
        this.bleCfgTag = bleCfgTag;
        this._setState(DfuState.READY);
    }

    performDFU(zipFilename, callback) {
        if (this._state !== DfuState.READY) {
            throw new Error('Not in READY state. DFU in progress or aborting.');
        }
        if (!zipFilename) {
            throw new Error('No zipFilePath provided.');
        }
        if (!callback) {
            throw new Error('No callback function provided.');
        }

        this._log(logLevel.INFO, `Performing DFU with file: ${zipFilename}`);
        this._setState(DfuState.IN_PROGRESS);

        this._fetchUpdates(zipFilename)
            .then(updates => this._performUpdates(updates))
            .then(() => {
                this._log(logLevel.INFO, 'DFU completed successfully.');
                this._setState(DfuState.READY);
                callback();
            })
            .catch(err => {
                if (!err) err = -1;
                // TODO: Properly pass error
                if (err.code === ErrorCode.ABORTED) {
                    this._log(logLevel.INFO, 'DFU aborted.');
                    callback(null, true);
                } else {
                    this._log(logLevel.ERROR, `DFU failed with error: ${err.message}.`);
                    callback(err);
                }
                this._setState(DfuState.READY);
            });
    }
    _performSingleUpdate(datFile, binFile) {
        return this._createBleTransport()
            .then(() => this._checkAbortState())
            .then(() => this._transferInitPacket(datFile))
            .then(() => this._transferFirmware(binFile))
            .then(() => this._transport.waitForDisconnection())
            .then(() => this._destroyBleTransport())
            .catch(err => {
                this._destroyBleTransport();
                throw err;
            });
    }
    _checkAbortState() {
        if (this._state === DfuState.ABORTING) {
            return Promise.reject(createError(ErrorCode.ABORTED, 'Abort was triggered.'));
        }
        return Promise.resolve();
    }

    _performUpdates(updates) {
        return updates.reduce((prevPromise, update) => {
            return prevPromise.then(() => this._performSingleUpdate(update.datFile, update.binFile));
        }, Promise.resolve());
    }

    _createBleTransport() {
        return Promise.resolve()
            .then(() => {
                this._log(logLevel.DEBUG, 'Creating DFU transport.');
                this._transport = new BleTransport(this.transportParameters, this.bleCfgTag, dfuEvent);
                this._setupTransportListeners();
                return this._transport.init();
            });
    }

    _destroyBleTransport() {
        if (this._transport) {
            this._log(logLevel.DEBUG, 'Destroying DFU transport.');
            this._removeTransportListeners();
            this._transport.destroy();
            this._transport = null;
        } else {
            this._log(logLevel.DEBUG, 'No DFU transport exists, so nothing to clean up.');
        }
    }

    _checkAbortState() {
        if (this._state === DfuState.ABORTING) {
            return Promise.reject(createError(ErrorCode.ABORTED, 'Abort was triggered.'));
        }
        return Promise.resolve();
    }

    _setupTransportListeners() {
        const progressInterval = 400;
        const onProgressUpdate = _.throttle(progressUpdate => {
            this._handleProgressUpdate(progressUpdate);
        }, progressInterval);

        const onLogMessage = (level, message) => {
            this._log(level, message);
        };

        this._transport.on('progressUpdate', onProgressUpdate);
        this._transport.on('logMessage', onLogMessage);
    }

    _removeTransportListeners() {
        this._transport.removeAllListeners('progressUpdate');
        this._transport.removeAllListeners('logMessage');
    }

    _transferInitPacket(file) {
        /**
         * DFU transfer start event.
         *
         * @event Dfu#transferStart
         * @type {Object}
         * @property {string} file.name - The name of the file being transferred.
         */
        this.emit('transferStart', file.name);
        return file.loadData().then(data => {
            return this._transport.sendInitPacket(data)
                .then(() => this.emit('transferComplete', file.name));
        });
    }

    _transferFirmware(file) {
        this.emit('transferStart', file.name);
        return file.loadData().then(data => {
            return this._transport.getFirmwareState(data)
                .then(state => {
                    this._speedometer = new DfuSpeedometer(data.length, state.offset);
                    return this._transport.sendFirmware(data);
                })

                /**
                 * DFU transfer complete event.
                 *
                 * @event Dfu#transferComplete
                 * @type {Object}
                 * @property {string} file.name - The name of the file that was transferred.
                 */
                .then(() => this.emit('transferComplete', file.name));
        });
    }

    _handleProgressUpdate(progressUpdate) {
        if (progressUpdate.offset) {
            this._speedometer.updateState(progressUpdate.offset);

            /**
             * DFU progress update event.
             *
             * @event Dfu#progressUpdate
             * @type {Object}
             * @property {Object} _ - Progress meta-data.
             */
            this.emit('progressUpdate', {
                stage: progressUpdate.stage,
                completedBytes: progressUpdate.offset,
                totalBytes: this._speedometer.totalBytes,
                bytesPerSecond: this._speedometer.calculateBytesPerSecond(),
                averageBytesPerSecond: this._speedometer.calculateAverageBytesPerSecond(),
                percentCompleted: this._speedometer.calculatePercentCompleted(),
            });
        } else {
            this.emit('progressUpdate', {
                stage: progressUpdate.stage,
            });
        }
    }

    _setState(state) {
        if (this._state !== state) {
            this._state = state;
        }
    }

    _fetchUpdates(zipFilename) {
        this._log(logLevel.DEBUG, `Loading zip file: ${zipFilename}`);
        const zipld = this._loadZipAsync(zipFilename);
        return Promise.all([
            zipld,
            zipld.then(zip => this._getManifest(zip))
        ])
            .then(result => {
                const zip = result[0];
                const manifest = result[1];
                return this._getFirmwareTypes(manifest).map(type => {
                    const firmwareUpdate = manifest[type];
                    const datFileName = firmwareUpdate.dat_file;
                    const binFileName = firmwareUpdate.bin_file;
                    this._log(logLevel.DEBUG, `Found ${type} files: ${datFileName}, ${binFileName}`);
                    return {
                        datFile: {
                            name: datFileName,
                            loadData: () => zip.file(datFileName).async('array'),
                        },
                        binFile: {
                            name: binFileName,
                            loadData: () => zip.file(binFileName).async('array'),
                        },
                    };
                });
            });
    }

    _getFirmwareTypes(manifest) {
        return [
            'softdevice',
            'bootloader',
            'softdevice_bootloader',
            'application',
        ].filter(type => !!manifest[type]);
    }

    _loadZipAsync(filename) {
        return new Promise((resolve, reject) => {
            this._loadZip(filename, (err, zip) => {
                err ? reject(err) : resolve(zip);
            });
        });
    }

    _getManifest(zip) {
        return new Promise((resolve, reject) => {
        zip.file('manifest.json')
            .async('string')
            .then(data => {
                let manifest;
                try {
                    // Parse manifest as JSON
                    manifest = JSON.parse(data).manifest;
                } catch (error) {
                    return reject(error);
                }
                // Return manifest
                return resolve(manifest);
            });
        });
    }
    _loadZip(filename, callback) {
        if (this.zipData) {
            callback(undefined, this.zipdata);
            return;
        }
        fetch(`./zips/${filename}`)
            .then(response => response.body)
            .then(body => body.getReader().read())
            .then(data => JSZip.loadAsync(data.value))
            .then(zipData => {
                this.zipData = zipData;
                console.log(zipData);
                callback(undefined, zipData);
            })
            .catch(error => callback(error));
    }

    _log(level, message) {
        console.log(message);
        //this.emit('logMessage', level, message);
    }
}

module.exports = {
    Dfu,
};
