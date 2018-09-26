import React, { Component } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
import { Button } from 'reactstrap';

function OpenAdapterComponent(active, callback) {
    let color = "success";
    if (!active) {
        color = "danger";
    }
    return (
        <Button color={color} onClick={callback} disabled={!active}>Select usb adapter</Button>
    );
}

export default OpenAdapterComponent;
