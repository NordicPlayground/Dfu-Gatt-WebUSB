/*global Module */
import React, { Component } from 'react';
import OpenAdapterComponent from './components/openAdapterComponent';
import DeviceScannerComponent from './components/deviceScannerComponent';
import DfuProgressComponent from './components/dfuProgressComponent';

import logo from './logo.svg';
import './App.css';

import { ble_cfg_t, ble_gap_cfg_t, ble_gap_cfg_role_count_t, ble_conn_cfg_t, ble_gatt_conn_cfg_t, ble_enable_params_t, ble_common_enable_params_t,
ble_gap_enable_params_t, ble_gatts_enable_params_t, ble_gatt_enable_params_t, ble_gap_scan_params_t } from 'pc-ble-driver-webusb'
import { sd_ble_enable, sd_ble_cfg_set, sd_ble_gap_scan_start, sd_ble_gap_scan_stop } from 'pc-ble-driver-webusb'
import { BLE_GAP_EVT_ADV_REPORT } from 'pc-ble-driver-webusb'
 import { NRF_SUCCESS, sd_rpc_log_severity_t } from 'pc-ble-driver-webusb'

import { WebusbInterface, H5Transport, SerializationTransport, AdapterInternal } from 'pc-ble-driver-webusb';

import  { ble_event_struct } from 'pc-ble-driver-webusb'

const { Dfu } = require('./dfu');
const { DeviceScanner } = require('./deviceScanner');

const BAUD_RATE = 1000000;

const reactDfuState = Object.freeze({
    NO_MODULE: 0,
    INITIALIZED: 1,
    SETUP: 2,
    SCANNING: 3,
    SELECTED_TARGET: 4,
    PERFORMING_UPDATES: 5,
    FINISHED: 6,
    FAILED: 10,
});

class App extends Component {

    constructor(){
        super();
        this.state = {
            currentState: reactDfuState.NO_MODULE,
            scanDevices: [],
            updateProgress: {
                percentage: 0,
            },
        };
        this.nextConnCfgTag = 1;
        this.adapter = null;
        this.deviceScanner = undefined;

        window.onload = () => {
            Module['onRuntimeInitialized'] = () => {
                console.log("Webassembly module loaded..");
                this.setState(prevState => {
                    return {currentState: reactDfuState.INITIALIZED}
                });
                //document.querySelector("#startProgramBtn").onclick = this.main.bind(this);
            }
        }
    }

    statusCallback(adapter, code, message) {
        console.log(code, message);
    }
    logCallback(adapter, severity, message) {
        console.log(message);
    }

    selectTarget() {
        let fetchDevListInterval;
        return new Promise(async (resolve, reject) => {
            this.deviceScanner = new DeviceScanner((err, device) => {
                if (err) {
                    return reject(err);
                }
                return resolve(device);
            });
            this.adapter.on('advReport', this.deviceScanner.boundParseResponse);
            const scanParam = new ble_gap_scan_params_t();
            scanParam.active.SET(1);
            scanParam.interval.SET(0x00A0);
            scanParam.window.SET(0x0050);
            scanParam.timeout.SET(0);
            let apiRes = await sd_ble_gap_scan_start(this.adapter, scanParam);
            scanParam.delete();

            const fetchDeviceList = () => {
                 const devList = this.deviceScanner.getList();

                 this.setState(prevState => {
                     return { scanDevices: devList };
                 });
            }
            fetchDevListInterval = setInterval(fetchDeviceList , 3000);
        })
        .then(async device => {
            this.adapter.removeListener('advReport', this.deviceScanner.boundParseResponse);
            clearInterval(fetchDevListInterval);
            this.deviceScanner = undefined;
            await sd_ble_gap_scan_stop(this.adapter);
            return device;
        });
    }

    addLogListeners(dfuObj) {
        console.log("Setup log listeners");
        dfuObj.on('logMessage', (severity, message) => console.log(message));
        dfuObj.on('transferStart', fileName => {
            this.setState(prevState => {
                return { currentState: reactDfuState.PERFORMING_UPDATES };
            });
            console.log('transferStart:', fileName)
        });
        dfuObj.on('transferComplete', fileName => {
            this.setState(prevState => {
                return { currentState: reactDfuState.FINISHED };
            });
            console.log('transferComplete:', fileName)
        });
        dfuObj.on('progressUpdate', progressUpdate => {
            let output = `progressUpdate: ${progressUpdate.stage}`;
            if (progressUpdate.percentCompleted) {
                this.setState(prevState => {
                    return { updateProgress: {percentage: progressUpdate.percentCompleted} };
                });
                output += `: ${progressUpdate.percentCompleted}%`;
                output += `, completed bytes: ${progressUpdate.completedBytes}, total: ${progressUpdate.totalBytes}`;
                output += `, B/s: ${progressUpdate.bytesPerSecond}, average B/s: ${progressUpdate.averageBytesPerSecond}`;
            }
            console.log(output);
        });
    }


    async bleCfgSet(adapter) {
        let bleCfg = new ble_cfg_t();
        const gapCfg = new ble_gap_cfg_t(bleCfg.gap_cfg.GETADDR());
        const roleCountConfig = new ble_gap_cfg_role_count_t(gapCfg.role_count_cfg.GETADDR());
        roleCountConfig.periph_role_count.SET(1);
        roleCountConfig.central_role_count.SET(1);
        roleCountConfig.central_sec_count.SET(1);
        let errorCode = await sd_ble_cfg_set(adapter, 0x40, bleCfg, 0);
        bleCfg.delete();

        if (errorCode !== NRF_SUCCESS) {
            return Promise.reject(errorCode);
        }
        bleCfg = new ble_cfg_t();
        const connCfg = new ble_conn_cfg_t(bleCfg.conn_cfg.GETADDR());
        const gattConnCfg = new ble_gatt_conn_cfg_t(connCfg.gatt_conn_cfg.GETADDR());
        connCfg.conn_cfg_tag.SET(this.nextConnCfgTag);
        gattConnCfg.att_mtu.SET(247);
        errorCode = await sd_ble_cfg_set(adapter, 0x23, bleCfg, 0);
        bleCfg.delete();
        if (errorCode !== NRF_SUCCESS) {
            return Promise.reject(errorCode);
        }

        console.log("Ble configuration was set")
        return Promise.resolve(adapter, this.nextConnCfgTag++);
    }

    async openAdapter() {
        const webusb = new WebusbInterface(BAUD_RATE);
        const h5 = new H5Transport(webusb, 5000);
        const serialization = new SerializationTransport(h5, 5000);
        const adapter = new AdapterInternal(serialization);
        adapter.logSeverityFilterSet(sd_rpc_log_severity_t.DEBUG)
        const res = await adapter.open(this.statusCallback, null, this.logCallback);
        if (res === NRF_SUCCESS) {
            console.log('Opened adapter');
        } else {
            console.log('Could not open adapter');
        }
        this.adapter = adapter;
        return adapter;
    }

    async performDFU(adapter, targetAddress, pathToZip, bleCfgTag) {
        return new Promise((resolve, reject) => {
            const transportParameters = {
                adapter,
                targetAddress,
                targetAddressType: 'BLE_GAP_ADDR_TYPE_RANDOM_STATIC',
            };
            const dfu = new Dfu(transportParameters, bleCfgTag);
            this.addLogListeners(dfu);

            dfu.performDFU(pathToZip, err => {
                if (err) {
                    reject(err);
                    this.setState(() => {
                        return {currentState: reactDfuState.FAILED}
                    });
                    return;
                }
                resolve(adapter);
            });
        });
    }

    async bleStackInit(adapter) {
        const enableParams = new ble_enable_params_t();
        const commonEnableParams = new ble_common_enable_params_t(enableParams.common_enable_params.GETADDR());
        const gapEnableParams = new ble_gap_enable_params_t(enableParams.gap_enable_params.GETADDR());
        const gattsEnableParams = new ble_gatts_enable_params_t(enableParams.gatts_enable_params.GETADDR());
        const gattEnableParams = new ble_gatt_enable_params_t(enableParams.gatt_enable_params.GETADDR());
        gattsEnableParams.attr_tab_size.SET(0x580);
        gattsEnableParams.service_changed.SET(false);
        gapEnableParams.periph_conn_count.SET(1);
        gapEnableParams.central_conn_count.SET(7);
        gapEnableParams.central_sec_count.SET(1);
        commonEnableParams.p_conn_bw_counts.SET(0);
        commonEnableParams.vs_uuid_count.SET(10);
        gattEnableParams.att_mtu.SET(247);

        const apiRes = await sd_ble_enable(adapter, enableParams, null);

        enableParams.delete();
        if (apiRes === NRF_SUCCESS) {
            console.log('Successfully enabled BLE!');
        } else {
            console.log('Could not enable BLE.');
        }
        if (apiRes !== NRF_SUCCESS) {
            return Promise.reject(apiRes);
        }
        return Promise.resolve(adapter);
    }

    async main() {
        console.log("mainfunc")
        const targetAddress = new Uint8Array([0xE0, 0xF4, 0x3D, 0x34, 0x6D, 0x56]);
        this.openAdapter()
        //.then(adapter => bleCfgSet(adapter))
        .then(adapter => {
            this.setState(prevState => {
                return {currentState: reactDfuState.SETUP}
            });
            return this.bleStackInit(adapter)
        })
        .then(() => {
            this.setState(prevState => {
                return { currentState: reactDfuState.SCANNING }
            });
            return this.selectTarget()
        })
        .then(device => {
            this.setState(prevState => {
                return { currentState: reactDfuState.SELECTED_TARGET }
            });
            return this.performDFU(this.adapter, device.address, 'dfu_test_app_hrm_s132.zip', 0)
    })
        //.then(adapter => adapter.close())
        .catch(err => console.log(err));
    }

    deviceToConnectSelected(device) {
        console.log(device);
        this.deviceScanner.stop(device);
    }

    dfuTriggerOp() {
        const webusb = new WebusbInterface(0);
        return webusb.enterBootloader();
    }


    selectStateComponent() {
        switch (this.state.currentState) {
            case reactDfuState.NO_MODULE: {
                return OpenAdapterComponent(false, this.main.bind(this), this.dfuTriggerOp.bind(this))
            }
            case reactDfuState.INITIALIZED: {
                return OpenAdapterComponent(true, this.main.bind(this), this.dfuTriggerOp.bind(this))
            }
            case reactDfuState.SETUP: {
                return (<p> Setting up..</p>)
            }
            case reactDfuState.SCANNING: {
                return <DeviceScannerComponent list={this.state.scanDevices} callback={this.deviceToConnectSelected.bind(this)} />
            }
            case reactDfuState.SELECTED_TARGET: {
                return (<p> Selected target..</p>)
            }
            case reactDfuState.PERFORMING_UPDATES: {
                return <DfuProgressComponent percentage={this.state.updateProgress.percentage} />
            }
            case reactDfuState.FINISHED: {
                return (<p> DFU FINISHED</p>)
            }
            case reactDfuState.FAILED: {
                return (<p> DFU FAILED</p>)
            }
        }
        return (<p></p>);
    };

    render() {
        return (
            <div className="App" key={1}>
            <header className="App-header">
              <img src={logo} className="App-logo" alt="logo" />
              <h1 className="App-title">NRF DFU</h1>
            </header>
            <br />
                {this.selectStateComponent()}

            </div>
        );
      }
}



export default App;
