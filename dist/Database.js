"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Database = void 0;
const influxdb_client_1 = require("@influxdata/influxdb-client");
class Database {
    static connect(opts, tagName) {
        const db = new Database();
        db.measurement = opts.measurement;
        db.fieldMap = opts.fieldMap;
        const influxFieldTypes = {};
        const setInfluxFieldTypes = (keys) => {
            for (const [_name, key] of Object.entries(keys)) {
                if (key._type !== undefined && key._mapping !== undefined) {
                    influxFieldTypes[key._mapping] = key._type;
                }
                else {
                    setInfluxFieldTypes(key);
                }
            }
        };
        setInfluxFieldTypes(opts.fieldMap);
        db.conn = new influxdb_client_1.InfluxDB({
            url: opts.url,
            token: opts.token
        }).getWriteApi(opts.org, opts.bucket, 's');
        db.conn.useDefaultTags({ vin: tagName });
        return db;
    }
    async write(data) {
        const point = new influxdb_client_1.Point(this.measurement);
        const addValues = (keys, values) => {
            for (const [name, key] of Object.entries(keys)) {
                if (key._type !== undefined && key._mapping !== undefined) {
                    if (values[name] !== null) {
                        switch (key._type) {
                            case 'float':
                                point.floatField(key._mapping, values[name]);
                                break;
                            case 'boolean':
                                point.booleanField(key._mapping, values[name]);
                                break;
                            case 'string':
                                point.stringField(key._mapping, values[name]);
                                break;
                            case 'int':
                                point.intField(key._mapping, values[name]);
                                break;
                        }
                    }
                }
                else if (values[name] != null) {
                    addValues(key, values[name]);
                }
            }
        };
        addValues(this.fieldMap, data);
        this.conn.writePoint(point);
        return await this.conn.flush();
    }
}
exports.Database = Database;
//# sourceMappingURL=Database.js.map