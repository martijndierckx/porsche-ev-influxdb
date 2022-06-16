import 'source-map-support/register';
import { Database } from './Database';
import PorscheConnect, { PorscheConnectConfig, Environment, VehicleOverview, VehiclePosition, VehicleEMobility, PorschePrivacyError } from 'porsche-connect';
import fs from 'fs';
import Moment from 'moment';
import Express from 'express';

(async () => {
  let data = {};

  // Set refresh interval & Wait period
  const INTERVAL_PARKED = process.env.INTERVAL_PARKED ? parseInt(process.env.INTERVAL_PARKED) : 60000;
  const INTERVAL = process.env.INTERVAL ? parseInt(process.env.INTERVAL) : 5000;

  // Configure Porsche connection
  const porscheConnOpts: PorscheConnectConfig = {
    username: process.env.PORSCHE_USER,
    password: process.env.PORSCHE_PASSWORD,
    env: Environment.nl_BE
  };
  const VIN = process.env.VIN;
  const porsche = new PorscheConnect(porscheConnOpts);

  // Configure webserver
  if (process.env.HTTP_PORT) {
    const HTTP_PORT = parseInt(process.env.HTTP_PORT);
    const express = Express();

    express.get('/data', (_req, res) => {
      res.send(data);
    });

    express.listen(HTTP_PORT, () => {
      console.log(`HTTP listening on port ${HTTP_PORT}`);
    });
  }

  // Retrieve vehicle data
  const vehicles = await porsche.getVehicles();
  const vehicle = vehicles.find((x) => {
    return x.vin.toLowerCase() == VIN.toLowerCase();
  });
  if (!vehicle) {
    console.error(`Could not retrieve vehicle with VIN ${VIN}`);
    process.exit(1); // Force quit / restart
  }

  // Configure field map for Influx
  const influxFieldMap = JSON.parse(fs.readFileSync(process.env.INFLUX_MAP_FILE ?? './src/influx_map.json').toString());

  // Connect to Influx
  const influxConnOpts = {
    url: process.env.INFLUX_URL,
    bucket: process.env.INFLUX_BUCKET,
    org: process.env.INFLUX_ORG,
    token: process.env.INFLUX_TOKEN,
    measurement: process.env.INFLUX_MEASUREMENT,
    fieldMap: influxFieldMap
  };
  const db = Database.connect(influxConnOpts, VIN);

  // Cached position
  const cachedPosition = {
    position: {
      latitude: null,
      longitude: null
    },
    parkedOrCharging: false,
    ts: null
  };

  // Check if values need to be read every 100ms
  let running = false;
  setInterval(async () => {
    const timeSinceLastFetch = Moment().diff(cachedPosition.ts ?? 0);
    if (
      !running &&
      (cachedPosition.ts == null ||
        (timeSinceLastFetch >= INTERVAL && !cachedPosition.parkedOrCharging) ||
        (timeSinceLastFetch >= INTERVAL_PARKED && cachedPosition.parkedOrCharging))
    ) {
      running = true;

      // Get overview
      let overview: VehicleOverview;
      try {
        overview = await porsche.getVehicleCurrentOverview(vehicle.vin);
      } catch (e) {
        if (e instanceof PorschePrivacyError) {
          console.error(`Vehicle (probably) in privacy mode. Waiting 10 seconds before quiting/retrying...`);
          await new Promise((resolve) => setTimeout(resolve, 10000));
        } else {
          console.error(`Retrieving overview failed:`);
        }
        console.error(e);
        process.exit(1); // Force quit / restart
      }

      // Get position
      let position: VehiclePosition;
      try {
        position = await porsche.getVehiclePosition(vehicle.vin);
      } catch (e) {
        console.error(`Retrieving position failed:`);
        console.error(e);
        process.exit(1); // Force quit / restart
      }

      // Get emobility
      let emob: VehicleEMobility;
      try {
        emob = await porsche.getVehicleEmobilityInfo(vehicle.vin, vehicle.carModel);
      } catch (e) {
        console.error(`Retrieving emobility failed:`);
        console.error(e);
        process.exit(1); // Force quit / restart
      }

      // Determine if parked
      let parked = true;
      if (
        cachedPosition.ts == null ||
        cachedPosition.position.latitude != position.carCoordinate.latitude ||
        cachedPosition.position.longitude != position.carCoordinate.longitude
      ) {
        parked = false;
      }

      // Determine if charging
      const charging = emob.batteryChargeStatus.chargingState == 'CHARGING';

      // Cache position
      cachedPosition.position = position.carCoordinate;
      cachedPosition.parkedOrCharging = parked || charging;
      cachedPosition.ts = Moment();

      // Transform data
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
        charging: charging,
        charge: charging
          ? {
              rate: emob.batteryChargeStatus.chargeRate.valueInKmPerHour,
              power: emob.batteryChargeStatus.chargingPower,
              DC: emob.batteryChargeStatus.chargingInDCMode
            }
          : null
      };

      // Write values
      try {
        await db.write(data);
        console.log(`Data written to InfluxDB`);
      } catch (e) {
        console.error(`Writing data to InfluxDB (${influxConnOpts.url}) failed:`);
        console.error(e);
        process.exit(1); // Force quit / restart
      }

      running = false;
    }
  }, 100);
})();
