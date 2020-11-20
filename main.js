'use strict';

/*
 * Created with @iobroker/create-adapter v1.24.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const { clearIntervalAsync, setIntervalAsync } = require('set-interval-async/dynamic');

// The device communicates over http only
const http = require('http');

// Default options for HTTP get
const getOptions = {
    // Sub-second timeout as should be pretty much instant and lower than the lowest polling frequency.
    // TODO: this should possibly be config variable lower than polling frequency?
    timeout: 750
};

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
 * 
 * You'd think it would be more efficient to have one huge regexp and match that, extracting
 * TIC value and all the circuit labels & values in one go, but tested this and actually
 * negligable difference between that and running multiple matches. The latter being
 * more elegant (if you can call that) to code though so staying with this.
 */

const circuits = [
    { name: 'c1', powerStateName: 'c1.power', energyStateName: 'c1.energy', labelStateName: 'c1.label', lpRegexp: new RegExp(/c1Name = getLabel\("(.*?) *"\);\s*?c1 = (\d+)/, 's'), jsonWatts: 'data1' },
    { name: 'c2', powerStateName: 'c2.power', energyStateName: 'c2.energy', labelStateName: 'c2.label', lpRegexp: new RegExp(/c2Name = getLabel\("(.*?) *"\);\s*?c2 = (\d+)/, 's'), jsonWatts: 'data2' },
    { name: 'c3', powerStateName: 'c3.power', energyStateName: 'c3.energy', labelStateName: 'c3.label', lpRegexp: new RegExp(/c3Name = getLabel\("(.*?) *"\);\s*?c3 = (\d+)/, 's'), jsonWatts: 'data3' },
    { name: 'c4', powerStateName: 'c4.power', energyStateName: 'c4.energy', labelStateName: 'c4.label', lpRegexp: new RegExp(/c4Name = getLabel\("(.*?) *"\);\s*?c4 = (\d+)/, 's'), jsonWatts: 'data4' },
    { name: 'c5', powerStateName: 'c5.power', energyStateName: 'c5.energy', labelStateName: 'c5.label', lpRegexp: new RegExp(/c5Name = getLabel\("(.*?) *"\);\s*?c5 = (\d+)/, 's'), jsonWatts: 'data5' },
    { name: 'Total', powerStateName: 'cTotal.power', energyStateName: 'cTotal.energy' },
    { name: 'TIC', energyStateName: 'TICReading', energyRegexp: "conso_base = '(.*)'", scale: 0.001 },
];
const circuitTotal = 5; // Must match element number above

class LegrandEcocompteur extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor() {
        super({
            name: 'legrand-ecocompteur',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.lastIndex = 0;
        this.lastJSON = 0;
    }

    // Create all the objects & states
    async createObjects() {
        this.log.debug('Creating adapter objects');
        circuits.forEach(async (circuit) => {
            if ('powerStateName' in circuit || 'labelStateName' in circuit) {
                // Need to create a channel for ths circuit
                await this.setObjectNotExistsAsync(circuit.name, {
                    type: 'channel',
                    common: {
                        name: circuit.name,
                        role: 'info'
                    }
                });
            }
            if ('labelStateName' in circuit) {
                await this.setObjectNotExistsAsync(circuit.labelStateName, {
                    type: 'state',
                    common: {
                        name: circuit.name + ' label',
                        type: 'string',
                        role: 'text',
                        read: true,
                        write: true
                    }
                });
            }

            if ('powerStateName' in circuit) {
                // For kWh calculations, for each circuit, keep track of:
                // - Timestamp of last valid reading.
                // - Value of last valid reading.
                // Only for circuits with power input which is why is here.

                circuit.lastTimestamp = 0;
                circuit.lastPower = 0;

                await this.setObjectNotExistsAsync(circuit.powerStateName, {
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
            }
            if ('energyStateName' in circuit) {
                await this.setObjectNotExistsAsync(circuit.energyStateName, {
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
            }
        });
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Error if we don't have configuration
        if (this.config.baseURL && this.config.pollJSON && this.config.pollIndex) {
            this.log.info('baseURL: ' + this.config.baseURL + ' JSON Poll: ' + this.config.pollJSON + ' Index Poll: ' + this.config.pollIndex);

            await this.createObjects();
            await this.hitIndex();
            this.log.debug('Initial fetch done, starting interval...');

            // Configured timers in ms
            const pollIndex = this.config.pollIndex * 1000;
            const pollJSON = this.config.pollJSON * 1000;

            // Start interval timers for subsiquent fetches
            this.interval = setIntervalAsync(async () => {
                // Hit JSON or Index depending on which is most overdue
                const now = Date.now();
                if ((now - this.lastJSON - pollJSON) > (now - this.lastIndex - pollIndex)) {
                    // JSON is most overdue
                    await this.hitJSON();
                } else {
                    // Index is most overdue
                    await this.hitIndex();
                }
            }, Math.min(pollIndex, pollJSON));
        } else {
            this.log.error('Please configure the adapter settings');
        }
    }

    async hitIndex() {
        const body = await this.doRequest('1.html');
        await this.parseIndex(body);
    }

    async hitJSON() {
        const body = await this.doRequest('inst.json');
        await this.parseJSON(body);
    }

    // Fetch a page from the device and pass body to the callback (or call the error callback if given).
    doRequest(path) {
        return new Promise((resolve, reject) => {
            this.log.debug('Loading ' + path + '...');

            const req = http.get(new URL(path, this.config.baseURL), getOptions, res => {
                let body = '';
                res.on('data', data => {
                    body += data;
                });
                res.on('end', () => {
                    if (res.statusCode == 200) {
                        resolve(body);
                    } else {
                        this.log.error('Bad status code loading ' + path + ' (' + res.statusCode + ')');
                        reject();
                    }
                });
            });
            req.on('error', error => {
                this.log.error('Request error: ' + error.message);
                reject();
            });
            req.on('timeout', () => {
                this.log.error('Request timeout!');
                // No need to call ecb here as destroy will trigger 'error' event which does that.
                req.destroy(new Error('timeout'));
            });
            req.end();
        });
    }

    // As we store the last valid readings on a per-circuit basis (when calculating
    // energy)... then validation can be passed that circuit and it's last valid
    // value can be used if spurious.
    validateCircuitPower(circuit, power) {
        if (this.config.validationMax > 0) {
            if (power > this.config.validationMax) {
                // ... replacing invalid readings with the last good reading
                if (circuit.lastTimestamp > 0) {
                    this.log.warn(`Suprious reading from ${circuit.name}: ${power} keeping previous value`);
                    power = circuit.lastPower;
                } else {
                    // ... unless there is none and then zero it out
                    this.log.warn(`Suprious reading from ${circuit.name}: ${power} setting to zero`);
                    power = 0;
                }
            }
        }
        return power;
    }

    // Whenever a circuit reading is recevied this method will update
    // it's kWh energy total
    async updateCircuitEnergy(circuit, timestamp, power) {
        if (circuit.lastTimestamp > 0) {
            // We want the period in hours for kWh calculation
            const period = (timestamp - circuit.lastTimestamp) / 1000 / 3600;

            let kWh = power / 1000 * period;
            this.log.debug(`${circuit.name} - lastPower: ${circuit.lastPower} @ period: ${period} = ${kWh} kWh`);
            const state = await this.getStateAsync(circuit.energyStateName);
            if (!state || !state.val) {
                this.log.warn(`state is null for ${circuit.name} - it will be reset`);
            } else {
                kWh += state.val;
            }
            await this.setStateChangedAsync(circuit.energyStateName, { val: kWh, ack: true });
        }
        // Remember this reading value & timestamp for next cycle
        circuit.lastTimestamp = timestamp;
        circuit.lastPower = power;
    }

    // Store total and calculate energy
    async updateTotal(timestamp, power) {
        const circuit = circuits[circuitTotal];
        // Special case - update total power
        this.updateCircuitEnergy(circuit, timestamp, power);
        await this.setStateChangedAsync(circuit.powerStateName, { val: power, ack: true });
    }

    /*
     * Function to pull out all power labels (as well as TIC reading) and start interval
     * timers.
     * This is the callback only on the first fetch.
     */
    async parseIndex(page) {
        const timestamp = Date.now();
        this.lastIndex = timestamp;

        let totalPower = 0;
        for (const circuit of circuits) {
            if ('lpRegexp' in circuit) {
                const matches = page.match(circuit.lpRegexp);
                if (!matches) {
                    this.log.error(`No matches for in page for ${circuit.name}`);
                    // TODO: zero out this value?
                } else {
                    const label = matches[1];
                    const power = this.validateCircuitPower(circuit, Number(matches[2]));
                    this.log.debug(`${circuit.name} (${label}): ${power}`);
                    await this.setStateChangedAsync(circuit.labelStateName, { val: label, ack: true });
                    await this.setStateChangedAsync(circuit.powerStateName, { val: power, ack: true });
                    totalPower += power;

                    await this.updateCircuitEnergy(circuit, timestamp, power);
                }
            }
            if ('energyRegexp' in circuit) {
                const matches = page.match(circuit.energyRegexp);
                if (!matches) {
                    this.log.error(`No matches for in page for ${circuit.name}`);
                }
                const energy = matches[1] * circuit.scale;
                this.log.debug(`${circuit.name}: ${energy}`);
                await this.setStateChangedAsync(circuit.energyStateName, { val: energy, ack: true });
            }
        }

        // Don't forget total
        await this.updateTotal(timestamp, totalPower);
    }

    // Zero everything out to prevent bogus values. Happens at shutdown.
    async zeroReadings() {
        this.log.info('Setting zero readings');
        this.lastJSONTimestamp = 0;
        for (const circuit of circuits) {
            if ('powerStateName' in circuit) {
                await this.setStateAsync(circuit.powerStateName, { val: 0, ack: true });
            }
        };
    }

    // Process good response
    async parseJSON(body) {
        const timestamp = Date.now();
        this.lastJSON = timestamp;

        try {
            const json = JSON.parse(body);

            let totalPower = 0;
            for (const circuit of circuits) {
                if ('jsonWatts' in circuit) {
                    const power = this.validateCircuitPower(circuit, json[circuit.jsonWatts]);
                    this.log.debug(`${circuit.name}: ${power}`);
                    await this.setStateAsync(circuit.powerStateName, { val: power, ack: true });
                    totalPower += power;

                    await this.updateCircuitEnergy(circuit, timestamp, power);
                }
            }
            // Don't forget total
            await this.updateTotal(timestamp, totalPower);
        } catch (error) {
            // TODO: zero out readings?
            this.log.error(error);
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.log.info('cleaned everything up...');
            clearIntervalAsync(this.interval).then(() => {
                this.zeroReadings().then(() => {
                    callback();
                });
            });
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