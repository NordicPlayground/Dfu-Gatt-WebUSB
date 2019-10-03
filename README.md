# About

[![Greenkeeper badge](https://badges.greenkeeper.io/NordicPlayground/Dfu-Gatt-WebUSB.svg)](https://greenkeeper.io/)

This is an example program of using pc-ble-driver-webusb for DFU (device firmware upgrade) over gatt. 
No other programs or dependencies than Google Chrome is needed on the target machine performing the DFU. Just enter the URL where the Dfu-Gatt-WebUSB is hosted, plug in a compatible nrf-dongle, and you're good to go!

Currently using SD API V3, but can modified to support other versions as well.

# Installation
* "git clone https://github.com/mathiasap/Dfu-Gatt-WebUSB.git"
* "cd Dfu-Gatt-WebUSB"
* "npm install"
* "Copy ```pc_ble_driver_sd_api_v3.js``` and  ```pc_ble_driver_sd_api_v3.wasm``` from ```node_modules\pc-ble-driver-webusb\build\v3\``` folder to ```public\``` folder if missing. 
* "npm start" (development) or "npm run build" (production)

The application must be served over https in production due to security features in WebUSB.

# Usage
A [modified connectivity firmware](https://github.com/mathiasap/pc-ble-driver-webusb/tree/experimental_firmware/experimental_connectivity_firmware) for the PCA10059 with interfaces for WebUSB is needed for this to work. Standard connectivity firmware uses interfaces 1 and 2 for transfers, which get claimed by the operating system. The WebUSB configuration found in src/sdk/src/js/transport/serial.js assumes interfaces 3 and 4 exists and are available for WebUSB to claim.
The device you want to upgrade must have the DFU gatts service enabled. (e.g entering secure bootloader with dfu service enabled)

# Status
* DFU for device in bootloader mode is supported. 
* Buttonless DFU is work in progress. 
* Code must be changed to use other packages than dfu_test_app_hrm_s132.zip
