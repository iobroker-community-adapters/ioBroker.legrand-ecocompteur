'use strict';

/*
 * Created with @iobroker/create-adapter v1.24.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// The device communicates over http only
const http = require('http');

/*
 * Configuration for each circuit.
 * - Regexp to find label on index.
 * - element to find reading in JSON.
 * - Our state names for label, instantaneous power and total energy.
 *
 * It's done this way so we can use a dummy circuit for totals & do things in loops nicely(ish).
 * Total must come last!
 *
 * Maybe we should do this in a loop in the constructor but what's the point? ;)
 */

const circuits = [
    { name: 'c1', powerStateName: 'c1.power', energyStateName: 'c1.energy', labelStateName: 'c1.label', labelRegexp: 'c1Name = getLabel\\("(.*)"', jsonWatts: 'data1' },
    { name: 'c2', powerStateName: 'c2.power', energyStateName: 'c2.energy', labelStateName: 'c2.label', labelRegexp: 'c2Name = getLabel\\("(.*)"', jsonWatts: 'data2' },
    { name: 'c3', powerStateName: 'c3.power', energyStateName: 'c3.energy', labelStateName: 'c3.label', labelRegexp: 'c3Name = getLabel\\("(.*)"', jsonWatts: 'data3' },
    { name: 'c4', powerStateName: 'c4.power', energyStateName: 'c4.energy', labelStateName: 'c4.label', labelRegexp: 'c4Name = getLabel\\("(.*)"', jsonWatts: 'data4' },
    { name: 'c5', powerStateName: 'c5.power', energyStateName: 'c5.energy', labelStateName: 'c5.label', labelRegexp: 'c5Name = getLabel\\("(.*)"', jsonWatts: 'data5' },
    { name: 'Total', powerStateName: 'cTotal.power', energyStateName: 'cTotal.energy' },
];

class LegrandEcocompteur extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor() {
        super({
            name: 'legrand-ecocompteur',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));

        /*
         * For kWh calculations, keep track of:
         * - Timestamp of last valid JSON reading.
         * - Array (empty to be filled later) of last readings.
         */
        this.lastJSONTimestamp = 0;
        this.lastCircuitWatts = [];

        // Timers (to clear on cleanup)
        this.JSONTimer;
        this.IndexTimer;
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
             * This also starts full timeout polling process.
             */
            this.hitPage(this.parseFullPage.bind(this));
        } else {
            this.log.error('Please configure the adapter settings');
        }
    }

    // Fetch a page from the device and pass body to the callback (or call the error callback if given).
    doRequest(path, cb, ecb) {
        this.log.debug('Loading ' + path + '...');
        const options = {
            host: this.config.ip,
            port: '80',
            path: path,
            method: 'GET',
            // Sub-second timeout as should be pretty much instant and lower than the lowest polling frequency.
            // TODO: this should possibly be config variable lower than polling frequency?
            timeout: 750
        };

        const req = http.request(options, res => {
            let body = '';
            res.on('data', data => {
                body += data;
            });
            res.on('end', () => {
                if (res.statusCode == 200) {
                    cb(body);
                } else {
                    this.log.error('Bad status code loading ' + path + ' (' + res.statusCode + ')');
                    if (typeof ecb !== 'undefined') { ecb(); }
                }
            });
        });
        req.on('error', error => {
            this.log.error('Request error: ' + error.code);
            if (typeof ecb !== 'undefined') { ecb(); }
        });
        req.on('timeout', () => {
            this.log.error('Request timeout!');
            // No need to call ecb here as destroy will trigger 'error' event which does that.
            req.destroy(new Error('timeout'));
        });
        req.end();
    }

    hitPage(cb) {
        this.doRequest('/1.html', cb);
    }

    /*
     * Function to pulls out the TIC reading and updates that state.
     * This is the back on every page load (except first when it's called anyhow).
     */
    parseTICPage(page) {
        // TIC interface kWh reading... note this is presented in watts so divide by 1000
        const TICReading = page.match(/conso_base = '(.*)'/)[1] / 1000;
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
        }, () => {
            this.setState(TICStateName, { val: TICReading, ack: true });
        });
    }

    /*
     * Function to pull out all power labels (as well as TIC reading) and start interval
     * timers.
     * This is the callback only on the first fetch.
     */
    parseFullPage(page) {
        // Handle TIC reading
        this.parseTICPage(page);

        circuits.forEach(circuit => {
            if ('labelRegexp' in circuit) {
                // This is a 'real' circuit - parse out the label
                let label = page.match(circuit.labelRegexp)[1];
                label = label.trim();
                this.log.debug('Circuit ' + circuit.name + ': ' + label);

                this.setObjectNotExists(circuit.labelStateName, {
                    type: 'state',
                    common: {
                        name: circuit.name + ' label',
                        type: 'string',
                        role: 'text',
                        read: true,
                        write: true
                    }
                }, () => {
                    this.setState(circuit.labelStateName, { val: label, ack: true });
                });
            }

            // Always create state for instantaneous power reading to use later...
            this.setObjectNotExists(circuit.powerStateName, {
                type: 'state',
                common: {
                    name: circuit.name + ' instantaneous power',
                    type: 'number',
                    role: 'value',
                    unit: 'W',
                    read: true,
                    write: true
                }
            });
            /// ... and total energy for this circuit
            this.setObjectNotExists(circuit.energyStateName, {
                type: 'state',
                common: {
                    name: circuit.name + ' energy',
                    type: 'number',
                    role: 'value',
                    unit: 'kWh',
                    read: true,
                    write: true
                }
            });
        });

        /*
         * If we get here then the first page fetch was a success...
         * ... so start up the JSON interval timer.
         */
        this.JSONTimer = setInterval(this.hitJSON.bind(this), this.config.pollJSON * 1000);

        // .. and timer for subsiquent page fetches (just for TIC reading).
        this.IndexTimer = setInterval(this.hitPage.bind(this), this.config.pollIndex * 1000, this.parseTICPage.bind(this));
    }

    hitJSON() {
        this.doRequest('/inst.json', this.parseJSON.bind(this), this.zeroReadings.bind(this));
    }

    // Zero everything out to prevent bogus values. Happens at shutdown & on JSON read failures.
    zeroReadings() {
        // Only necessary if we have a good reading
        if (this.lastJSONTimestamp > 0) {
            this.log.info('Setting zero readings');
            this.lastJSONTimestamp = 0;
            circuits.forEach(circuit => {
                this.setState(circuit.powerStateName, { val: 0, ack: true });
                this.lastCircuitWatts[circuit.name] = 0;
            });
        }
    }

    // Process good response
    parseJSON(body) {
        const timestamp = Date.now();
        // We want the period in hours for kWh calculation
        const period = (timestamp - this.lastJSONTimestamp) / 1000 / 3600;

        try {
            const json = JSON.parse(body);

            let totalWatts = 0;
            circuits.forEach(circuit => {
                let watts = 0;
                if ('jsonWatts' in circuit) {
                    watts = json[circuit.jsonWatts];
                    // Validation. Values over maximum are assumed bad so zero out.
                    if (this.config.validationMax > 0) {
                        if (watts > this.config.validationMax) {
                            // Keep the last reading... unless there is none and then zero it out
                            if (this.lastJSONTimestamp > 0) {
                                this.log.warn('Suprious reading from ' + circuit.name + ': ' + watts + ' keeping previous value');
                                watts = this.lastCircuitWatts[circuit.name];
                            } else {
                                this.log.warn('Suprious reading from ' + circuit.name + ': ' + watts + ' setting to zero');
                                watts = 0;
                            }
                        }
                    }
                    totalWatts += watts;
                } else {
                    // Special case for total which must come last in the list of circuits!
                    watts = totalWatts;
                }
                this.setState(circuit.powerStateName, { val: watts, ack: true });

                // Work out kWh since last reading (only if period & last reading are good).
                const lastWatts = this.lastCircuitWatts[circuit.name];
                if (lastWatts > 0 && this.lastJSONTimestamp > 0) {
                    let kWh = lastWatts / 1000 * period;
                    this.log.debug(circuit.name + ': lastWatts ' + lastWatts + ' @ period ' + period + ' = ' + kWh + 'kWh');
                    this.getState(circuit.energyStateName, (err, state) => {
                        if (!err) {
                            if (state) {
                                kWh += state.val;
                            }
                            this.setState(circuit.energyStateName, { val: kWh, ack: true });
                        } else {
                            this.log.error(err);
                        }
                    });
                }
                this.lastCircuitWatts[circuit.name] = watts;
            });
            this.lastJSONTimestamp = timestamp;
        } catch (error) {
            this.log.error(error.message);
            this.zeroReadings();
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.log.info('cleaned everything up...');
            this.zeroReadings();
            clearInterval(this.JSONTimer);
            clearInterval(this.IndexTimer);
            callback();
        } catch (e) {
            callback();
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