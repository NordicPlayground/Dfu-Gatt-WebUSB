/*global Module */
import ControlPointService from './bleTransport/controlPointService';
import ButtonlessControlPointService from './bleTransport/buttonlessControlPointService';
import ObjectWriter from './bleTransport/objectWriter';
import { FirmwareState } from './dfuModels';

import { NRF_SUCCESS, NRF_ERROR_INVALID_PARAM, sd_rpc_app_status_t } from 'pc-ble-driver-webusb';

import { ble_gap_scan_params_t, ble_gap_conn_params_t, ble_gap_addr_t, ble_uuid_t, ble_gattc_handle_range_t } from 'pc-ble-driver-webusb';
import { sd_ble_gap_connect, sd_ble_gap_conn_param_update, sd_ble_gattc_primary_services_discover, sd_ble_gattc_characteristics_discover,
sd_ble_gattc_descriptors_discover, sd_ble_gattc_exchange_mtu_request } from 'pc-ble-driver-webusb';

import { uuidToCharacteristic } from 'pc-ble-driver-webusb';
const { bleUUID128t } = require('../util/uuid');


const { ObjectType, ErrorCode, ResultCode, createError } = require('./dfuConstants');
const { InitPacketState } = require('./dfuModels')
const EventEmitter = require('events');

const ATT_WRITE_COMMAND_HEADER_SIZE = 3;
const MAX_SUPPORTED_MTU_SIZE = 247;
const DEFAULT_PRN = 0;
const MAX_RETRIES = 3;

const DFU_SERVICE_UUID = 'FE59';
const DFU_CONTROL_POINT_UUID = '8EC90001F3154F609FB8838830DAEA50';
const DFU_PACKET_UUID = '8EC90002F3154F609FB8838830DAEA50';
const DFU_BUTTONLESS_UNBONDED_UUID = '8EC90003F3154F609FB8838830DAEA50';
const DFU_BUTTONLESS_BONDED_UUID = '8EC90004F3154F609FB8838830DAEA50';

class BleTransport extends EventEmitter {
    constructor(transportParameters, bleCfgTag) {
        super();
        this._adapter = transportParameters.adapter;
        this._transportParameters = transportParameters;
        this._isInitialized = false;
        this.bleCfgTag = bleCfgTag;
        this.uuid128 = new Map();
        this.handle = undefined;
        this.connected = false;
        this._handleConnParamUpdateRequest = this._handleConnParamUpdateRequest.bind(this);
        this.onDisconnected = this.onDisconnected.bind(this);
        this._adapter.on('connParamUpdateRequest', this._handleConnParamUpdateRequest);
        this._adapter.on('onDisconnected', this.onDisconnected);


        this.boundDescriptorDiscoveryNext = this.descriptorDiscoveryNext.bind(this);
        this.boundCharacteristicDiscoveryNext = this.characteristicDiscoveryNext.bind(this);

        this._adapter.on('descriptorDiscoveryNext', this.boundDescriptorDiscoveryNext);
        this._adapter.on('characteristicDiscoveryNext', this.boundCharacteristicDiscoveryNext);
    }
    _debug(msg) {
        console.log(msg)
    }

    async init() {
        if (this._isInitialized) {
            return Promise.resolve();
        }

        const targetAddress = this._transportParameters.targetAddress;
        const targetAddressType = this._transportParameters.targetAddressType;
        const prnValue = this._transportParameters.prnValue || DEFAULT_PRN;
        const mtuSize = this._transportParameters.mtuSize || MAX_SUPPORTED_MTU_SIZE;

        this._debug(`Initializing DFU transport with targetAddress: ${targetAddress}, ` +
            `targetAddressType: ${targetAddressType}, prnValue: ${prnValue}, mtuSize: ${mtuSize}.`);

        return this.addVsUuid()
            .then(() => this._connect(targetAddress, targetAddressType))
            .then(() => {
                const connUpdatedPromise = new Promise(resolve => this.on('connParametersUpdated', () => resolve()));
                const secParamsUpdatedPromise = new Promise(resolve => this.on('secParametersUpdated', () => resolve()));
                const timedOutPromise = new Promise(resolve => setTimeout(() => resolve(), 5000));
                return Promise.race([Promise.all([connUpdatedPromise/*, secParamsUpdatedPromise*/]), timedOutPromise]);
            })
            .then(this.serviceDiscoveryStart.bind(this))
            .then(this.characteristicDiscoveryStart.bind(this))
            .then(this.descriptorDiscoveryStart.bind(this))
            .then(this._enterDfuMode.bind(this))
            .then(() => {
                const controlPointChar = uuidToCharacteristic[this.uuid128[DFU_CONTROL_POINT_UUID].shortUuid];
                const packetChar = uuidToCharacteristic[this.uuid128[DFU_PACKET_UUID].shortUuid];
                this._controlPointService = new ControlPointService(this._adapter, controlPointChar);
                this._objectWriter = new ObjectWriter(this._adapter, controlPointChar, packetChar);
                this._objectWriter.on('packetWritten', progress => {
                    this._emitTransferEvent(progress.offset, progress.type);
                });
                return this._startCharacteristicsNotifications(controlPointChar);
            })
            .then(() => this._setPrn(prnValue))
            .then(() => this._setMtuSize(mtuSize))
            .then(() => this._isInitialized = true);
    }

    async addVsUuid() {
        const addFromString = string => {
            const uuidBuffer = new Uint8Array(Buffer.from(string, 'hex'));
            const uuid = new bleUUID128t(uuidBuffer);
            this.uuid128[string] = uuid;
            return uuid.register(this._adapter);
        };
        await addFromString(DFU_CONTROL_POINT_UUID);
        await addFromString(DFU_PACKET_UUID);
        await addFromString(DFU_BUTTONLESS_UNBONDED_UUID);
        await addFromString(DFU_BUTTONLESS_BONDED_UUID);
    }


    onDisconnected(evt) {
        if (evt && evt.detail && evt.detail.handle !== undefined) {
            if (this.connected && evt.detail.handle === this.handle) {
                this.connected = false;
                this.handle = undefined;
            }
        }
    }
    /**
     * Connect to the target device.
     *
     * @param targetAddress the address to connect to
     * @param targetAddressType the target address type
     * @returns Promise that resolves with device when connected
     * @private
     */
    async _connect(targetAddress, targetAddressType) {
        const scanParam = new ble_gap_scan_params_t();
        const connParam = new ble_gap_conn_params_t();
        const peerAddr = new ble_gap_addr_t();

        const MSEC_TO_UNITS = (TIME, RES) => (TIME * 1000) / RES;

        scanParam.active.SET(1);
        scanParam.interval.SET(0x00A0);
        scanParam.window.SET(0x0050);
        scanParam.timeout.SET(0x3C);
        connParam.min_conn_interval.SET(MSEC_TO_UNITS(7.5, 1250));
        connParam.max_conn_interval.SET(MSEC_TO_UNITS(7.5, 1250));
        connParam.conn_sup_timeout.SET(MSEC_TO_UNITS(4000, 10000));
        connParam.slave_latency.SET(0);

        const addrBuflen = peerAddr.addr.LENGTH();
        if (targetAddress.length !== addrBuflen) {
            scanParam.delete();
            connParam.delete();
            peerAddr.delete();
            return NRF_ERROR_INVALID_PARAM;
        }
        Module.writeArrayToMemory(targetAddress.reverse(), peerAddr.addr.GETADDR());
        let typeVal;
        switch (targetAddressType) {
            case 'BLE_GAP_ADDR_TYPE_PUBLIC': typeVal = 0; break;
            case 'BLE_GAP_ADDR_TYPE_RANDOM_STATIC': typeVal = 1; break;
            case 'BLE_GAP_ADDR_TYPE_RANDOM_PRIVATE_RESOLVABLE': typeVal = 2; break;
            case 'BLE_GAP_ADDR_TYPE_RANDOM_PRIVATE_NON_RESOLVABLE': typeVal = 3; break;
            default: typeVal = 1;
        }
        peerAddr.addr_type.SET(typeVal);
        const onConnectedPromise = new Promise((resolve, reject) => {
            const evtCb = evt => {
                this._adapter.removeListener('onConnected', evtCb)
                clearTimeout(connectionTimeout);
                if (!evt || !evt.detail) {
                    reject();
                } else {
                    this.handle = evt.detail.handle;
                    this.connected = true;
                    resolve(evt.handle);
                }
            };
            const connectionTimeout = setTimeout(evtCb, 10000);
            this._adapter.on('onConnected', evtCb)
        });
        const apiRes = await sd_ble_gap_connect(this._adapter, peerAddr, scanParam, connParam);
        scanParam.delete();
        connParam.delete();
        peerAddr.delete();

        if (apiRes === NRF_SUCCESS) {
            return onConnectedPromise;
        }
        throw (`Could not connect to device. Error ${apiRes}`);
    }

    /**
     * Get the target to enter DFU mode.
     *
     * @param device the DFU target device
     * @returns Promise: the DFU target device in DFU mode.
     * @private
     */
    _enterDfuMode() {
        if (this.uuid128[DFU_BUTTONLESS_BONDED_UUID].found) {
            return this._triggerButtonlessDfu(uuidToCharacteristic[this.uuid128[DFU_BUTTONLESS_BONDED_UUID].shortUuid], true);
        } else if (this.uuid128[DFU_BUTTONLESS_UNBONDED_UUID].found) {
            return this._triggerButtonlessDfu(uuidToCharacteristic[this.uuid128[DFU_BUTTONLESS_UNBONDED_UUID].shortUuid], false);
        } else {
            console.log("no buttonless")
            return Promise.resolve();
        }
    }

    /**
     * Use the given characteristic to trigger buttonless DFU and reconnect
     * to the target (which is now in DFU mode).
     *
     * @param characteristic the buttonless DFU characteristic to use.
     * @param bonded {boolean} is it the "bonded" characteristic?
     * @returns Promise: The device in DFU mode.
     * @private
     */
    _triggerButtonlessDfu(characteristic, bonded) {
        console.log(characteristic)
        const buttonlessControlPointService = new ButtonlessControlPointService(this._adapter, characteristic);

        return this._startCharacteristicsIndications(characteristic)
            .then(() => buttonlessControlPointService.enterBootloader())
            .then(() => this.waitForDisconnection())
            .then(() => {
                console.log("after disconnect");
                if (!bonded) {
                    this._addOneToAddress();
                }
                return this._connectIfNeeded(this._transportParameters.targetAddress, this._transportParameters.targetAddressType);
            });
    }

    /**
     * Destroys the transport. Removes all listeners, so that the transport can
     * be garbage collected.
     */
    destroy() {
        if (this._objectWriter) {
            this._objectWriter.removeAllListeners();
        }
        this._adapter.removeListener('connParamUpdateRequest', this._handleConnParamUpdateRequest);
        this.cleanup()
    }


    _setPrn(prn) {
        return this._controlPointService.setPRN(prn)
            .then(() => this._objectWriter.setPrn(prn));
    }

    _setMtuSize(mtuSize) {
        return new Promise((resolve, reject) => {
            const mtuRequestCb = evt => {
                this._adapter.removeListener('mtuExchangeResponse', mtuRequestCb);
                if (evt && evt.detail && evt.detail.acceptedMtu) {
                    console.log(`Accepted mtu ${evt.detail.acceptedMtu}`);
                    this._objectWriter.setMtuSize(evt.detail.acceptedMtu - ATT_WRITE_COMMAND_HEADER_SIZE);
                    resolve();
                }
                reject('Received invalid mtu response');
            };
            this._adapter.on('mtuExchangeResponse', mtuRequestCb);
            sd_ble_gattc_exchange_mtu_request(this._adapter, this.handle, mtuSize)
            .then(apiRes => {
                if (apiRes !== NRF_SUCCESS) {
                    reject('Could not send mtu request');
                }
            });
        });
    }

    sendFirmware(data) {
        this._emitInitializeEvent(ObjectType.DATA);
        return this.getFirmwareState(data)
            .then(state => {
                this._debug(`Sending firmware: ${state.toString()}`);
                const objects = state.remainingObjects;
                if (state.hasResumablePartialObject) {
                    const object = state.remainingPartialObject;
                    return this._resumeWriteObject(object, ObjectType.DATA, state.offset, state.crc32).then(progress =>
                        this._createAndWriteObjects(objects, ObjectType.DATA, progress.offset, progress.crc32));
                }
                return this._createAndWriteObjects(objects, ObjectType.DATA, state.offset, state.crc32);
        });
    }


    getInitPacketState(data) {
        return this.init()
            .then(() => this._controlPointService.selectObject(ObjectType.COMMAND))
            .then(response => {
                this._debug(`Got init packet state from target. Offset: ${response.offset}, ` +
                    `crc32: ${response.crc32}, maximumSize: ${response.maximumSize}.`);

                return new InitPacketState(data, response);
            });
    }

    getFirmwareState(data) {
        return this.init()
            .then(() => this._controlPointService.selectObject(ObjectType.DATA))
            .then(response => {
                this._debug(`Got firmware state from target. Offset: ${response.offset}, ` +
                    `crc32: ${response.crc32}, maximumSize: ${response.maximumSize}.`);

                return new FirmwareState(data, response);
            });
    }

    waitForDisconnection() {
        this._debug('Waiting for target device to disconnect.');
        const TIMEOUT_MS = 10000;

        return new Promise((resolve, reject) => {
            if (!this.connected) {
                this._debug('Already disconnected from target device.');
                return resolve();
            }
            let timeout;
            const disconnectionHandler = evt => {
                if (!this.connected || (evt && evt.detail && evt.detail.handle === this.handle)) {
                    clearTimeout(timeout);
                    this._debug('Received disconnection event for target device.');
                    this._adapter.removeListener('onDisconnected', disconnectionHandler);
                    resolve();
                }
            };

            timeout = setTimeout(() => {
                this._adapter.removeListener('onDisconnected', disconnectionHandler);
                reject(createError(ErrorCode.DISCONNECTION_TIMEOUT,
                    'Timed out when waiting for target device to disconnect.'));
            }, TIMEOUT_MS);

            this._adapter.on('onDisconnected', disconnectionHandler);
        });
    }

    sendInitPacket(data) {
        this._emitInitializeEvent(ObjectType.COMMAND);
        console.log("send init packet")
        return this.getInitPacketState(data)
            .then(state => {
                this._debug(`Sending init packet: ${state.toString()}`);
                if (state.hasResumablePartialObject) {
                    const object = state.remainingData;
                    return this._resumeWriteObject(object, ObjectType.COMMAND, state.offset, state.crc32);
                }
                return this._createAndWriteObject(state.remainingData, ObjectType.COMMAND);
            });
    }

    _createAndWriteObjects(objects, type, offset, crc32) {
        return objects.reduce((prevPromise, object) => {
            return prevPromise.then(progress =>
                this._createAndWriteObject(object, type, progress.offset, progress.crc32)
            );
        }, Promise.resolve({ offset, crc32 }));
    }

    _createAndWriteObject(data, type, offset, crc32) {
        return new Promise((resolve, reject) => {
            let attempts = 0;
            const tryWrite = () => {
                this._controlPointService.createObject(type, data.length)
                    .then(() => this._writeObject(data, type, offset, crc32))
                    .then(progress => resolve(progress))
                    .catch(error => {
                        attempts++;
                        if (this._shouldRetry(attempts, error)) {
                            tryWrite();
                        } else {
                            reject(error);
                        }
                    });
            };
            tryWrite();
        });
    }

    _writeObject(data, type, offset, crc32) {
        return this._objectWriter.writeObject(data, type, offset, crc32)
            .then(progress => {
                return this._validateProgress(progress)
                    .then(() => this._controlPointService.execute())
                    .then(() => progress);
            });
    }

    _resumeWriteObject(data, type, offset, crc32) {
        if (data.length === 0) {
            const progress = {offset, crc32};
            return this._controlPointService.execute()
                .catch(error => {
                    if (error.code === ErrorCode.COMMAND_ERROR &&
                        error.commandErrorCode === ResultCode.OPERATION_NOT_PERMITTED) {
                        this._debug('Received OPERATION_NOT_PERMITTED when resuming and trying to execute. ' +
                            'This indicates that execute has already been done, so ignoring this.');
                    } else {
                        throw error;
                    }
                })
                .then(() => progress);
        } else {
            return this._writeObject(data, type, offset, crc32);
        }
    }


    _shouldRetry(attempts, error) {
        if (attempts < MAX_RETRIES &&
            error.code !== ErrorCode.ABORTED &&
            error.code !== ErrorCode.NOTIFICATION_TIMEOUT) {
            return true;
        }
        return false;
    }

    _validateProgress(progressInfo) {
        return this._controlPointService.calculateChecksum()
            .then(response => {
                //console.log('Validate Progress ')
                //console.log(response)
                //console.log(`Expect ${progressInfo.offset}`)
                // Same checks are being done in objectWriter. Could we reuse?
                if (progressInfo.offset !== response.offset) {
                    throw createError(ErrorCode.INVALID_OFFSET, `Error when validating offset. ` +
                        `Got ${response.offset}, but expected ${progressInfo.offset}.`);
                }
                if (progressInfo.crc32 !== response.crc32) {
                    throw createError(ErrorCode.INVALID_CRC, `Error when validating CRC. ` +
                        `Got ${response.crc32}, but expected ${progressInfo.crc32}.`);
                }
            });
    }


    _emitTransferEvent(offset, type) {
        const event = {
            stage: `Transferring ${this._getObjectTypeString(type)}`
        };
        if (type === ObjectType.DATA) {
            event.offset = offset;
        }
        //console.log(event);
        this.emit('progressUpdate', event);
    }
    _emitInitializeEvent(type) {
        this.emit('progressUpdate', {
            stage: `Initializing ${this._getObjectTypeString(type)}`
        });
    }

    _getObjectTypeString(type) {
        switch (type) {
            case ObjectType.COMMAND:
                return 'init packet';
            case ObjectType.DATA:
                return 'firmware';
        }
        return 'unknown object';
    }
    async _handleConnParamUpdateRequest(evt) {
        this._debug('Received connection parameter update request from target device.');
        const connParams = new ble_gap_conn_params_t();
        connParams.min_conn_interval.SET(evt.detail.min_conn_interval);
        connParams.max_conn_interval.SET(evt.detail.max_conn_interval);
        connParams.slave_latency.SET(evt.detail.slave_latency);
        connParams.conn_sup_timeout.SET(evt.detail.conn_sup_timeout);
        await sd_ble_gap_conn_param_update(this._adapter, this.handle, connParams);
        connParams.delete();
        this.emit('connParametersUpdated');
    }

    _startCharacteristicsNotifications(characteristicId) {
        const ack = false;
        return this._startCharacteristicsNotificationsOrIndications(characteristicId, ack);
    }
    _startCharacteristicsIndications(characteristicId) {
        const ack = true;
        return this._startCharacteristicsNotificationsOrIndications(characteristicId, ack);
    }

    _startCharacteristicsNotificationsOrIndications(characteristic, requireAck) {
        //return new Promise((resolve, reject) => {
            // In adapter.js, the terminology for Indications and Notifications is:
            // - BLE Indications are "notifications with ack"
            // - BLE Notifications are "notifications without ack"
            console.log("start notification")
            const data = new Uint8Array([requireAck ? 2 : 1, 0]);
            return characteristic.writeDescriptor(data, true);
        //});
    }


    async serviceDiscoveryStart() {

        let startHandle = 0x01;
        let uuidBuffer = new Uint8Array(Buffer.from(DFU_SERVICE_UUID, 'hex'));
        const uuid = new ble_uuid_t();
        uuid.uuid.SET(new DataView(uuidBuffer.buffer, 0, 2).getUint16(0));
        uuid.type.SET(1);

        //let uuid128 = new bleUUID128t(new Uint8Array([0xef, 0x68, 0x03, 0x00,   0x9b, 0x35,  0x49, 0x33,   0x9b, 0x10,   0x52, 0xff, 0xa9, 0x74, 0x00, 0x42]));
        //await uuid128.register(currentAdapter);

        console.log("Discovering services..");
        const foundDfuServicePromise = new Promise((resolve, reject) => {
            let discoveryTimeout;
            const evtCb = (evt) => {
                if (!evt || !evt.detail) {
                    this._adapter.removeListener('serviceDiscovered', evtCb);
                    clearTimeout(discoveryTimeout);
                    reject();
                } else {
                    console.log(evt)
                    if (evt.detail.service.uuidValue.toString(16).toLowerCase() === DFU_SERVICE_UUID.toLowerCase()) {
                        this._adapter.removeListener('serviceDiscovered', evtCb);
                        clearTimeout(discoveryTimeout);
                        resolve(evt.detail.service);
                    } else {
                        console.log(evt.detail.service.uuidValue.toString(16))
                    }
                }
            };

            discoveryTimeout = setTimeout(evtCb, 10000);
            this._adapter.on('serviceDiscovered', evtCb)
        });

        const errorCode = await sd_ble_gattc_primary_services_discover(this._adapter, this.handle, startHandle, uuid);
        uuid.delete();

        if (errorCode !== NRF_SUCCESS) {
            const errorMessage = `Could discover services. Code #${errorCode}`;
            this._adapter.statusHandler(sd_rpc_app_status_t.PKT_UNEXPECTED, errorMessage);
            return Promise.reject(errorCode);
        }
        return foundDfuServicePromise;
    }
    async characteristicDiscoveryStart(gattcService) {
        const discoveredCharPromise = new Promise((resolve, reject) => {
            const discoveredCb = evt => {
                if (evt.detail.characteristic === undefined) {
                    this._adapter.removeListener('characteristicDiscovered', discoveredCb);
                    resolve(gattcService);
                }
            };
            this._adapter.on('characteristicDiscovered', discoveredCb);
        });
        this.characteristicDiscoveryNext(gattcService);
        return discoveredCharPromise;
    }
    async characteristicDiscoveryNext(gattcService) {
        console.log("Discovering characteristics");
        const handleRange = new ble_gattc_handle_range_t();
        handleRange.start_handle.SET(gattcService.serviceCurrentHandle);
        handleRange.end_handle.SET(gattcService.serviceEndHandle);
        const apiRes = await sd_ble_gattc_characteristics_discover(this._adapter, this.handle, handleRange);
        handleRange.delete();
        return apiRes;
    }



    async descriptorDiscoveryStart(gattcService) {
        const discoveredDescriptorsPromise = new Promise((resolve, reject) => {
            const discoveredCb = evt => {
                if (evt.detail.descriptor === undefined) {
                    this._adapter.removeListener('descriptorDiscovered', discoveredCb);
                    resolve(gattcService);
                }
                console.log("Added descriptor")
            };
            this._adapter.on('descriptorDiscovered', discoveredCb);
        });
        gattcService.serviceCurrentHandle = gattcService.serviceStartHandle;
        this.descriptorDiscoveryNext(gattcService);
        return discoveredDescriptorsPromise;
    }

    async descriptorDiscoveryNext(gattcService) {
        console.log("Discovering descriptors");
        const handleRange = new ble_gattc_handle_range_t();
        handleRange.start_handle.SET(gattcService.serviceCurrentHandle);
        handleRange.end_handle.SET(gattcService.serviceEndHandle);
        const apiRes = await sd_ble_gattc_descriptors_discover(this._adapter, this.handle, handleRange);
        handleRange.delete();
        return apiRes;
    }

    cleanup() {
        this.uuid128.forEach((uuid128, key) => {
            uuid128.clean();
        });
    }
}
export {
    BleTransport,
};
