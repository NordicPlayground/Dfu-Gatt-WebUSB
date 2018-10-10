import React, { Component } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
import { Button } from 'reactstrap';

function OpenAdapterComponent(active, callback, dfuTrigger) {
    let color = "success";
    if (!active) {
        color = "danger";
    }
    return (
        <div>
        <Button color={color} onClick={callback} disabled={!active}>Select usb adapter</Button>
        <Button color={color} onClick={dfuTrigger} disabled={!active}>Trigger DFU</Button>
        </div>
    );
}

export default OpenAdapterComponent;
