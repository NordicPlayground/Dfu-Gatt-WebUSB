/*global Module */
import { ble_uuid128_t, ble_uuid_t } from 'pc-ble-driver-webusb';
import { sd_ble_uuid_vs_add } from 'pc-ble-driver-webusb';
import { NRF_SUCCESS } from 'pc-ble-driver-webusb';


class bleUUID128t {
    constructor(bytes) {
        let bytesLE = new Uint8Array(bytes).reverse();
        this.uuid128 = new ble_uuid128_t();
        if (bytesLE.length <= this.uuid128.uuid128.LENGTH()) {
            Module.HEAPU8.set(bytesLE, this.uuid128.uuid128.GETADDR());
        }

        this.uuid = new ble_uuid_t();
        this.shortUuid = new DataView(bytesLE.buffer, 12, 2).getUint16(0, true);
        this.uuid.uuid.SET(this.shortUuid);
        this.found = false;
    }
    async register(adapter) {
        let errorCode = await sd_ble_uuid_vs_add(adapter, this.uuid128, this.uuid.type.GETADDR());
        if (errorCode !== NRF_SUCCESS) {
            console.log("Could not add 128 bit characteristic")
        } else {
            console.log("UUID register successful!")

            const discvCb = evt => {
                if (this.shortUuid === evt.detail.uuid) {
                    this.found = true;
                    console.log("Found uuid "+this.shortUuid);
                    adapter.removeListener("uuidValueDiscovered", discvCb);
                }
            }
            adapter.on("uuidValueDiscovered", discvCb);
        }
    }
    clean() {
        this.uuid128.delete();
        this.uuid.delete();
    }
}

/*module.exports =*/ export {
    bleUUID128t,
};
