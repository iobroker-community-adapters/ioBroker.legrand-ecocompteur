'use strict';

/*
 * Created with @iobroker/create-adapter v1.24.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// The device communicates over http only
const http = require('http');

class LegrandEcocompteur extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            name: 'legrand-ecocompteur',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Error if we don't have the target IP address configured
        if (this.config.ip && this.config.pollJSON && this.config.pollIndex) {
            this.log.info('ip: ' + this.config.ip + ' JSON Poll: ' + this.config.pollJSON + ' Index Poll: ' + this.config.pollIndex);

            /**
             * Hit the index page first to parse out circuit names, etc.
             */
            this.hitPage();
        } else {
            this.log.error("Please configure the adapter settings");
        }
    }

    hitPage() {
        this.log.debug('Loading index page...');
        const options = {
            host: this.config.ip,
            port: '80',
            path: '/1.html',
            method: 'GET'
        };

        const req = http.request(options, res => {
            this.log.debug('statusCode: ' + res.statusCode);

            let body = '';
            res.on('data', data => {
                body += data;
            });
            res.on('end', _ => {
                if (res.statusCode == 200) {
                    this.parsePage(body);
                } else {
                    this.log.debug('Bad status code: ' + res.statusCode);
                }
            });
        });
        req.on('error', error => {
            this.log.error('Request error: ' + error.code);
        });
        req.end();
    }

    parsePage(page) {
        // TIC interface kWh reading... note this is presented in watts so divide by 1000
        let TICReading = page.match(/conso_base = \'(.*)\'/)[1] / 1000;
        this.log.debug('kWh: ' + TICReading);

        // Create state and set value
        const TICStateName = 'TICReading';
        this.setObjectNotExists(TICStateName, {
            type: 'state',
            common: {
                name: 'TIC Reading',
                type: 'number',
                role: 'value',
                read: true,
                write: true
            },
        }, _ => {
            this.setState(TICStateName, { val: TICReading, ack: true });
        });
        
        // Parse out the labels for each circuit and create
        for (let cno = 1; cno < 6; cno++) {
            let regexp = 'c' + cno + 'Name = getLabel\\("(.*)"';
            let label = page.match(regexp)[1];
            label = label.trim();
            this.log.debug('Circuit name ' + cno + ': ' + label);

            // Create state and set value
            const labelStateName = 'c' + cno + '.label';
            const powerStateName = 'c' + cno + '.power';
            this.setObjectNotExists(labelStateName, {
                type: 'state',
                common: {
                    name: 'Circuit ' + cno + ' label',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: true
                }
            }, _ => {
                this.setState(labelStateName, { val: label, ack: true });
            });

            // At this point let's create state for instantaneous power reading to use later
            this.setObjectNotExists(powerStateName, {
                type: 'state',
                common: {
                    name: 'Circuit ' + cno + ' instantaneous power',
                    type: 'number',
                    role: 'value',
                    read: true,
                    write: true
                }
            });
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.log.info('cleaned everything up...');
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed object changes
     * @param {string} id
     * @param {ioBroker.Object | null | undefined} obj
     */
    onObjectChange(id, obj) {
        if (obj) {
            // The object was changed
            this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
        } else {
            // The object was deleted
            this.log.info(`object ${id} deleted`);
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new LegrandEcocompteur(options);
} else {
    // otherwise start the instance directly
    new LegrandEcocompteur();
}