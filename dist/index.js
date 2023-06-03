"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
require("source-map-support/register");
const Database_1 = require("./Database");
const porsche_connect_1 = tslib_1.__importStar(require("porsche-connect"));
const fs_1 = tslib_1.__importDefault(require("fs"));
const moment_1 = tslib_1.__importDefault(require("moment"));
const express_1 = tslib_1.__importDefault(require("express"));
(async () => {
    let data = {};
    const INTERVAL_PRIVACY = process.env.INTERVAL_PRIVACY ? parseInt(process.env.INTERVAL_PRIVACY) : 300000;
    const INTERVAL_PARKED = process.env.INTERVAL_PARKED ? parseInt(process.env.INTERVAL_PARKED) : 60000;
    const INTERVAL = process.env.INTERVAL ? parseInt(process.env.INTERVAL) : 5000;
    const porscheConnOpts = {
        username: process.env.PORSCHE_USER,
        password: process.env.PORSCHE_PASSWORD,
        env: porsche_connect_1.Environment.nl_BE
    };
    const VIN = process.env.VIN;
    const porsche = new porsche_connect_1.default(porscheConnOpts);
    let express = null;
    const setupHTTPServer = async () => {
        if (process.env.HTTP_PORT && express == null) {
            const HTTP_PORT = parseInt(process.env.HTTP_PORT);
            express = (0, express_1.default)();
            express.get('/data', (_req, res) => {
                res.send(data);
            });
            express.listen(HTTP_PORT, () => {
                console.log(`HTTP listening on port ${HTTP_PORT}`);
            });
        }
    };
    const vehicles = await porsche.getVehicles();
    const vehicle = vehicles.find((x) => {
        return x.vin.toLowerCase() == VIN.toLowerCase();
    });
    if (!vehicle) {
        console.error(`Could not retrieve vehicle with VIN ${VIN}`);
        process.exit(1);
    }
    const influxFieldMap = JSON.parse(fs_1.default.readFileSync(process.env.INFLUX_MAP_FILE ?? './src/influx_map.json').toString());
    const influxConnOpts = {
        url: process.env.INFLUX_URL,
        bucket: process.env.INFLUX_BUCKET,
        org: process.env.INFLUX_ORG,
        token: process.env.INFLUX_TOKEN,
        measurement: process.env.INFLUX_MEASUREMENT,
        fieldMap: influxFieldMap
    };
    const db = Database_1.Database.connect(influxConnOpts, VIN);
    const cachedPosition = {
        position: {
            latitude: null,
            longitude: null
        },
        parkedOrCharging: false,
        inPrivacyMode: false,
        ts: null
    };
    let running = false;
    setInterval(async () => {
        const timeSinceLastFetch = (0, moment_1.default)().diff(cachedPosition.ts ?? 0);
        if (!running &&
            (cachedPosition.ts == null ||
                (timeSinceLastFetch >= INTERVAL && !cachedPosition.parkedOrCharging && !cachedPosition.inPrivacyMode) ||
                (timeSinceLastFetch >= INTERVAL_PARKED && cachedPosition.parkedOrCharging && !cachedPosition.inPrivacyMode) ||
                (timeSinceLastFetch >= INTERVAL_PRIVACY && cachedPosition.inPrivacyMode))) {
            running = true;
            let inPrivacyMode;
            try {
                inPrivacyMode = await vehicle.isInPrivacyMode();
            }
            catch (e) {
                console.error(`Retrieving privacy mode failed:`);
                console.error(e);
                process.exit(1);
            }
            if (inPrivacyMode) {
                console.log(`Vehicle is in privacy mode. Waiting ${INTERVAL_PRIVACY / 1000} seconds before attempting again.`);
                cachedPosition.inPrivacyMode = true;
                cachedPosition.ts = (0, moment_1.default)();
            }
            else {
                cachedPosition.inPrivacyMode = false;
                let overview;
                try {
                    overview = await vehicle.getCurrentOverview();
                }
                catch (e) {
                    if (e instanceof porsche_connect_1.PorschePrivacyError) {
                        console.error(`Vehicle (probably) in privacy mode. Waiting 10 seconds before quiting/retrying...`);
                        await new Promise((resolve) => setTimeout(resolve, 10000));
                    }
                    else {
                        console.error(`Retrieving overview failed:`);
                    }
                    console.error(e);
                    process.exit(1);
                }
                let position;
                try {
                    position = await vehicle.getPosition();
                }
                catch (e) {
                    console.error(`Retrieving position failed:`);
                    console.error(e);
                    process.exit(1);
                }
                let emob;
                try {
                    emob = await vehicle.getEmobilityInfo();
                }
                catch (e) {
                    console.error(`Retrieving emobility failed:`);
                    console.error(e);
                    process.exit(1);
                }
                let parked = true;
                if (cachedPosition.ts == null ||
                    cachedPosition.position.latitude != position.carCoordinate.latitude ||
                    cachedPosition.position.longitude != position.carCoordinate.longitude) {
                    parked = false;
                }
                const isCharging = emob.batteryChargeStatus.chargingState == 'CHARGING';
                cachedPosition.position = position.carCoordinate;
                cachedPosition.parkedOrCharging = parked || isCharging;
                cachedPosition.ts = (0, moment_1.default)();
                data = {
                    batteryLevel: overview.batteryLevel.value,
                    remainingElectricRange: overview.remainingRanges.electricalRange.distance.valueInKilometers,
                    mileage: overview.mileage.valueInKilometers,
                    position: {
                        latitude: position.carCoordinate.latitude,
                        longitude: position.carCoordinate.longitude,
                        heading: position.heading
                    },
                    closed: overview.overallOpenStatus == 'CLOSED',
                    pluggedIn: emob.batteryChargeStatus.plugState == 'CONNECTED',
                    charging: isCharging,
                    charge: isCharging
                        ? {
                            rate: emob.batteryChargeStatus.chargeRate.valueInKmPerHour,
                            power: emob.batteryChargeStatus.chargingPower,
                            DC: emob.batteryChargeStatus.chargingInDCMode
                        }
                        : null
                };
                setupHTTPServer();
                try {
                    await db.write(data);
                    console.log(`Data written to InfluxDB`);
                }
                catch (e) {
                    console.error(`Writing data to InfluxDB (${influxConnOpts.url}) failed:`);
                    console.error(e);
                    process.exit(1);
                }
            }
            running = false;
        }
    }, 100);
})();
//# sourceMappingURL=index.js.map