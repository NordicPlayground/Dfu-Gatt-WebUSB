import React, { Component } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
import { Progress } from 'reactstrap';

class DfuProgressComponent extends Component {

    constructor () {
        super();
        this.state = {
        };
    }

    render() {
        return (
            <div>
                Firmware update in progress..
                <br /> <br />
                {this.props.percentage}%
                <Progress animated color="success" value={this.props.percentage} />
            </div>
        );
    }
}

export default DfuProgressComponent;
