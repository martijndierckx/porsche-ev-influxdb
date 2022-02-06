import { InfluxDB, Point, WriteApi } from '@influxdata/influxdb-client';

export type DatabaseConnectionConfig = {
  url: string;
  token: string;
  org: string;
  bucket: string;
  measurement: string;
  fieldMap: any;
};

export class Database {
  private conn: WriteApi;

  private measurement: string;
  private fieldMap: any;

  public static connect(opts: DatabaseConnectionConfig, tagName: string) {
    const db = new Database();

    // Save params
    db.measurement = opts.measurement;
    db.fieldMap = opts.fieldMap;

    // Fieldmap to fields list
    const influxFieldTypes: { [column: string]: 'float' } = {};
    const setInfluxFieldTypes = (keys: any[]) => {
      for (const [_name, key] of Object.entries(keys)) {
        if (key._type !== undefined && key._mapping !== undefined) {
          influxFieldTypes[key._mapping] = key._type;
        } else {
          setInfluxFieldTypes(key);
        }
      }
    };
    setInfluxFieldTypes(opts.fieldMap);

    // Initiate connection
    db.conn = new InfluxDB({
      url: opts.url,
      token: opts.token
    }).getWriteApi(opts.org, opts.bucket, 's');

    // Setup default tags for all writes through this API
    db.conn.useDefaultTags({ vin: tagName });

    return db;
  }

  public async write(data: { [name: string]: any }): Promise<void> {
    // Create point
    const point = new Point(this.measurement);

    // Add values
    const addValues = (keys: any, values) => {
      for (const [name, key] of Object.entries<any>(keys)) {
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
        } else if (values[name] != null) {
          addValues(key, values[name]);
        }
      }
    };
    addValues(this.fieldMap, data);

    // Write
    this.conn.writePoint(point);
    return await this.conn.flush();
  }
}
