/*global Module */
const { ble_event_struct } = require('./sdk/src/js/bindings/bleEvtStruct');

class BleDevice {
    constructor(name, address, addrString) {
        this.name = name;
        this.address = address;
        this.addrString = addrString;
        this.ticksSinceAdv = 0;
        this.rssi = 0;
    }
    tick() {
        this.ticksSinceAdv += 1;
    }
}

class DeviceScanner {
    constructor(callback) {
        this.devices = new Map();
        this.sweepInterval = setInterval(() => this.devices.forEach(v => v.tick()), 100);
        this.ticksTimeout = 50;
        this.boundParseResponse = this.parseResponse.bind(this);
        this.callback = callback;
    }
    parseResponse(report) {
        let device;
        if (this.devices.has(report.addressString)) {
            device = this.devices.get(report.addressString);
        } else {
            device = new BleDevice(report.name, report.address, report.addressString);
            this.devices.set(report.addressString, device);
        }
        device.rssi = report.rssi;
        device.ticksSinceAdv = 0;
        if (report.name !== 0) {
            device.name = report.name;
        }
    }
    getList() {
        const availableDevices = new Array();
        this.devices.forEach(v => {
            if (v.ticksSinceAdv < this.ticksTimeout) {
                availableDevices.push(v);
            }
        });
        availableDevices.sort((a, b) => b.rssi - a.rssi);
        return availableDevices;
    }
    stop(device) {
        this.callback(null, device);
    }
}



module.exports = {
    DeviceScanner,
};
