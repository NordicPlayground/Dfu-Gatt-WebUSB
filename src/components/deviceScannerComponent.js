import React, { Component } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
import { ListGroup, ListGroupItem, Badge, Button } from 'reactstrap';

class DeviceScannerComponent extends Component {

    constructor () {
        super();
        this.state = {
            selectedDevice: {},
            list: [],
        };
    }

    setSelected(device) {
        this.setState(prevState => {
            return { selectedDevice: device };
        });
    }
    constructList(list) {
        return (<ListGroup>{list.map(item => (
                <div>
                    <ListGroupItem key={item.addrString} active={item.addrString === this.state.selectedDevice.addrString} onClick={() => this.setSelected(item)} color={item.addrString === this.state.selectedDevice.addrString?"success":"info"} >
                    <Badge pill>RSSI: {item.rssi}</Badge> - Local name: {item.name === 0?"N/A":item.name} - Target Address: {item.addrString} -
                    </ListGroupItem>
                </div>
            )
        )}</ListGroup>);
    }

    render() {
        const deviceList = this.constructList(this.props.list);
        const selectedInList = this.props.list.find(element => element.addrString === this.state.selectedDevice.addrString);
        return (
            <div>
                <Button color="success" disabled={!selectedInList} onClick={() => this.props.callback(this.state.selectedDevice)}>Select device for DFU</Button>
                <br />
                {deviceList}
            </div>
        );
    }
}

export default DeviceScannerComponent;
