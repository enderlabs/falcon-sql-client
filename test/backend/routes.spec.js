import fetch from 'node-fetch';
import {assert} from 'chai';
import {assoc, contains, dissoc, gt, keys, merge, sort, without} from 'ramda';
import Server from '../../backend/routes.js';
import {
    getConnections,
    getSanitizedConnections,
    saveConnection
} from '../../backend/persistent/Connections.js';
import {getSetting, saveSetting} from '../../backend/Settings.js';
import fs from 'fs';
import {
    username,
    apiKey,
    validFid,
    validUids,
    createGrid,
    configuration,
    sqlConnections,
    mysqlConnection,
    elasticsearchConnections,
    publicReadableS3Connections,
    apacheDrillConnections,
    apacheDrillStorage,
    testConnections,
    testSqlConnections
} from './utils.js';


// Shortcuts
function GET(path) {

    return fetch(`http://localhost:9494/${path}`, {
        method: 'GET',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
    });
}

function POST(path, body = {}) {
    return fetch(`http://localhost:9494/${path}`, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : null
    });
}

function PUT(path, body = {}) {
    return fetch(`http://localhost:9494/${path}`, {
        method: 'PUT',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : null
    });
}

function DELETE(path) {
    return fetch(`http://localhost:9494/${path}`, {
        method: 'DELETE',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
    });
}

let queryObject;
let server;
let connectionId;
describe('Routes - ', function () {
    beforeEach(() => {
        server = new Server();
        server.start();

        // Save some connections to the user's disk
        try {
            fs.unlinkSync(getSetting('CONNECTIONS_PATH'));
        } catch (e) {}
        try {
            fs.unlinkSync(getSetting('QUERIES_PATH'));
        } catch (e) {}
        try {
            fs.unlinkSync(getSetting('SETTINGS_PATH'));
        } catch (e) {}

        saveSetting('USERS', [{
            username, apiKey
        }]);

        /*
         * This is a little hacky: replace the default location
         * of the cert key file to somewhere that doesn't exist
         * so that when we start the server, the server runs as
         * HTTP and not HTTPS
         */
        saveSetting('KEY_FILE', 'non-existent-file');

        connectionId = saveConnection(sqlConnections);
        queryObject = {
            fid: validFid,
            uids: validUids.slice(0, 2), // since this particular query only has 2 columns
            refreshInterval: 60, // every minute
            query: 'SELECT * FROM ebola_2014 LIMIT 1',
            connectionId: connectionId
        };

    });

    afterEach(() => {
        server.close();
        server.queryScheduler.clearQueries();
    });


    it('ping - responds', function(done) {
        GET('ping')
        .then(() => done())
        .catch(done);
    });

    it('index page - returns 200', function(done) {
        GET('')
        .then(res => {
            assert.equal(res.status, 200);
            done();
        })
        .catch(done);
    });

    // OAuth
    it('oauth - returns 200 on loading the oauth page', function(done) {
        GET('oauth2/callback')
        .then(res => {
            assert.equal(res.status, 200);
            done();
        })
        .catch(done);
    });

    it('oauth - saves oauth access token with a username if valid', function(done) {
        saveSetting('USERS', []);

        assert.deepEqual(
            getSetting('USERS'),
            []
        );

        /*
         * This is a real live access token associated with
         * the user account plotly-database-connector on
         * https://plot.ly.
         *
         * This token is generated by visiting
         * https://plot.ly/o/authorize/?response_type=token&client_id=5sS4Kxx8lqcprixXHKAaCGUCXqPCEVLnRNTGeNQU&redirect_uri=http://localhost:9494/oauth2/callback
         * in your web browser.
         */

        const access_token = 'V0s0DotlapdYaFVPHk9LioYVluJ1hH';

        POST('oauth2/token', {
            access_token
        })
        .then(res => res.json().then(json => {
            assert.deepEqual(json, {});
            assert.equal(res.status, 201);
            assert.deepEqual(
                getSetting('USERS'),
                [{username: 'plotly-database-connector', accessToken: access_token}]
            );

            // We can save it again and we'll get a 200 instead of a 201
            POST('oauth2/token', {access_token})
            .then(res => res.json().then(json => {
                assert.deepEqual(json, {});
                assert.equal(res.status, 200);
                done();
            })).catch(done);
        }))
        .catch(done);
    });

    it('oauth - saving an access token that is not associated with a user account will fail with a 500 level error', function(done) {
        saveSetting('USERS', []);
        const access_token = 'lah lah lemons';
        POST('oauth2/token', {access_token})
        .then(res => res.json().then(json => {
            assert.deepEqual(json, {
                error: {
                    message: 'User was not found.'
                }
            });
            assert.equal(res.status, 500);
            assert.deepEqual(
                getSetting('USERS'),
                []
            );
            done();
        })).catch(done);
    });

    // One Time SQL Queries
    testSqlConnections.forEach(function createTest(connection) {
        it(`${connection.dialect} - query - runs a SQL query`, function(done) {
            this.timeout(5000);
            connectionId = saveConnection(connection);
            let sampleQuery = 'SELECT * FROM ebola_2014 LIMIT 1';
            if (connection.dialect === 'mssql') {
                sampleQuery = (
                    'SELECT TOP 1 * FROM ' +
                    `${connection.database}.dbo.ebola_2014`
                );
            }
            POST(`connections/${connectionId}/query`, {
                query: sampleQuery
            })
            .then(res => res.json())
            .then(response => {
                let expectedColumnNames;
                if (contains(connection.dialect, ['mariadb', 'mysql', 'mssql'])) {
                    expectedColumnNames = ['Country', 'Month', 'Year', 'Lat', 'Lon', 'Value'];
                } else if (connection.dialect === 'sqlite') {
                    expectedColumnNames = ['index', 'Country', 'Month', 'Year', 'Lat', 'Lon', 'Value'];
                } else {
                    expectedColumnNames = ['country', 'month', 'year', 'lat', 'lon', 'value'];
                }

                assert.deepEqual(
                    response,
                    {
                        rows: [
                            ({
                                'postgres': ['Guinea', 3, 14, '9.95', '-9.7', '122'],
                                'redshift': ['Guinea', 3, 14, '10', '-10', 122],
                                'mysql': ['Guinea', 3, 14, 10, -10, '122'],
                                'mariadb': ['Guinea', 3, 14, 10, -10, '122'],
                                'mssql': ['Guinea', 3, 14, 10, -10, '122'],
                                'sqlite': [0, 'Guinea', 3, 14, 9.95, -9.7, 122]
                            })[connection.dialect]
                        ],
                        columnnames: expectedColumnNames
                    }
                );

                done();
            }).catch(done);
        });

        it(`${connection.dialect} - query - fails when the SQL query contains a syntax error`, function(done) {
            this.timeout(5 * 1000);
            connectionId = saveConnection(connection);
            POST(`connections/${connectionId}/query`, {
                query: 'SELECZ'
            })
            .then(res => res.json().then(json => {
                assert.equal(res.status, 400);
                assert.deepEqual(
                    json,
                    {error: {message:
                        ({
                            postgres: 'syntax error at or near "SELECZ"',
                            redshift: 'syntax error at or near "SELECZ"',
                            mysql: 'ER_PARSE_ERROR: You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near \'SELECZ\' at line 1',
                            mariadb: "ER_PARSE_ERROR: You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near 'SELECZ' at line 1",
                            mssql: "Could not find stored procedure 'SELECZ'.",
                            sqlite: 'SQLITE_ERROR: near "SELECZ": syntax error'
                        })[connection.dialect]
                    }}
                );
                done();
            }))
            .catch(done);
        });

        it(`${connection.dialect} - query - succeeds when SQL query returns no data`, function(done) {
            this.timeout(60 * 1000);
            connectionId = saveConnection(connection);
            let query = 'SELECT * FROM ebola_2014 LIMIT 0';
            if (connection.dialect === 'mssql') {
                query = (
                    'SELECT TOP 0 * FROM ' +
                    `${connection.database}.dbo.ebola_2014`
                );
            }
            POST(`connections/${connectionId}/query`, {query})
            .then(res => res.json().then(json => {
                assert.equal(res.status, 200);
                assert.deepEqual(
                    json,
                    {
                        columnnames: [],
                        rows: [[]]
                    }
                );
                done();
            }))
            .catch(done);
        });

        // Meta info about the tables
        it(`${connection.dialect} - tables - returns a list of tables`, function(done) {
            this.timeout(5000);
            connectionId = saveConnection(connection);
            POST(`connections/${connectionId}/sql-tables`)
            .then(res => res.json())
            .then(json => {
                assert.deepEqual(
                    json,
                    [
                        'alcohol_consumption_by_country_2010',
                        'apple_stock_2014',
                        'ebola_2014',
                        'february_aa_flight_paths_2011',
                        'february_us_airport_traffic_2011',
                        'precipitation_2015_06_30',
                        'us_ag_exports_2011',
                        'us_cities_2014',
                        'usa_states_2014',
                        'walmart_store_openings_1962_2006',
                        'weather_data_seattle_2016',
                        'world_gdp_with_codes_2014'
                    ]
                );
                done();
            }).catch(done);
        });
    });

    // S3
    it('s3 - s3-keys returns a list of keys', function(done) {
        this.timeout(10000);
        const s3CredId = saveConnection(publicReadableS3Connections);
        POST(`connections/${s3CredId}/s3-keys`)
        .then(res => res.json())
        .then(files => {
            assert.deepEqual(
                JSON.stringify(files[0]),
                JSON.stringify({
                    'Key': '311.parquet/._SUCCESS.crc',
                    'LastModified': '2016-10-26T03:27:31.000Z',
                    'ETag': '"9dfecc15c928c9274ad273719aa7a3c0"',
                    'Size': 8,
                    'StorageClass': 'STANDARD',
                    'Owner': {
                        'DisplayName': 'chris',
                        'ID': '655b5b49d59fe8784105e397058bf0f410579195145a701c03b55f10920bc67a'
                    }
                })
            );
            done();
        }).catch(done);
    });

    it('s3 - s3-keys fails with the wrong connection credentials', function(done) {
        this.timeout(10000);
        const s3CredId = saveConnection({
            dialect: 's3',
            accessKeyId: 'asdf',
            secretAccessKey: 'fdsa',
            bucket: 'plotly-s3-connector-test'
        });
        POST(`connections/${s3CredId}/s3-keys`)
        .then(res => res.json().then(json => {
            assert.equal(res.status, 500);
            assert.deepEqual(json, {
                error: {message: 'The AWS Access Key Id you provided does not exist in our records.'}
            });
            done();
        }))
        .catch(done);
    });

    it('s3 - query returns data', function(done) {
        const s3CredId = saveConnection(publicReadableS3Connections);
        this.timeout(5000);
        POST(`connections/${s3CredId}/query`, {query: '5k-scatter.csv'})
        .then(res => res.json().then(json => {
            assert.equal(res.status, 200),
            assert.deepEqual(
                keys(json),
                ['columnnames', 'rows']
            );
            assert.deepEqual(
                json.rows.slice(0, 2),
                [
                    ['-0.790276857291', '-1.32900495883'],
                    ['0.931947948358', '0.266354435153']
                ]
            );
            done();
        })).catch(done);
    });

    // Apache Drill
    it('apache-drill - apache-drill-storage returns a list of storage items', function(done) {
        const s3CredId = saveConnection(apacheDrillConnections);

        this.timeout(5000);
        POST(`connections/${s3CredId}/apache-drill-storage`)
        .then(res => res.json())
        .then(storage => {
            assert.deepEqual(
                storage,
                apacheDrillStorage
            );
            done();
        }).catch(done);
    });

    it('apache-drill - apache-drill-s3-keys returns a list of s3 files', function(done) {
        const s3CredId = saveConnection(apacheDrillConnections);
        this.timeout(5000);
        POST(`connections/${s3CredId}/apache-drill-s3-keys`)
        .then(res => res.json())
        .then(files => {
            assert.deepEqual(
                JSON.stringify(files[0]),
                JSON.stringify({
                    'Key': '311.parquet/._SUCCESS.crc',
                    'LastModified': '2016-10-26T03:27:31.000Z',
                    'ETag': '"9dfecc15c928c9274ad273719aa7a3c0"',
                    'Size': 8,
                    'StorageClass': 'STANDARD',
                    'Owner': {
                        'DisplayName': 'chris',
                        'ID': '655b5b49d59fe8784105e397058bf0f410579195145a701c03b55f10920bc67a'
                    }
                })
            );
            done();
        }).catch(done);
    });

    // TODO - Missing elasticsearch and postgis tests

    // Connections
    testConnections.forEach(function(connection) {
        it(`connections - ${connection.dialect} - saves connections to a file if they are valid and if they do not exist`, function(done) {
            this.timeout(5 * 1000);
            fs.unlinkSync(getSetting('CONNECTIONS_PATH'));
            assert.deepEqual(getConnections(), []);
            POST('connections', connection)
            .then(res => res.json().then(json => {
                assert.deepEqual(
                    json,
                    {connectionId: getConnections()[0].id}
                );
                assert.equal(res.status, 200);
                assert.deepEqual(
                    [connection],
                    getConnections().map(dissoc('id'))
                );
                done();
            })).catch(done);
        });

        it(`connections - ${connection.dialect} - fails if the connections are not valid`, function(done) {
            this.timeout(5 * 1000);
            fs.unlinkSync(getSetting('CONNECTIONS_PATH'));
            assert.deepEqual(getConnections(), [], 'connections are empty at start');

            let connectionTypo;
            if (contains(connection.dialect, ['postgres', 'mysql', 'mariadb', 'redshift', 'mssql'])) {
                connectionTypo = merge(connection, {username: 'typo'});
            } else if (connection.dialect === 's3') {
                connectionTypo = merge(connection, {secretAccessKey: 'typo'});
            } else if (connection.dialect === 'elasticsearch') {
                connectionTypo = merge(connection, {host: 'https://lahlahlemons.com'});
            } else if (connection.dialect === 'apache drill') {
                connectionTypo = merge(connection, {host: 'https://lahlahlemons.com'});
            } else if (connection.dialect === 'sqlite') {
                connectionTypo = merge(connection, {storage: 'typo'});
            } else {
                throw new Error('Woops - missing an option in this test');
            }

            POST('connections', connectionTypo)
            .then(res => res.json().then(json => {
                if (contains(connection.dialect, ['mysql', 'mariadb'])) {
                    assert.include(
                        json.error.message,
                        "ER_ACCESS_DENIED_ERROR: Access denied for user 'typo'@"
                    );
                } else {
                    assert.deepEqual(json, {
                        error: {
                            message: ({
                                postgres: 'password authentication failed for user "typo"',
                                redshift: 'password authentication failed for user "typo"',
                                mssql: "Login failed for user 'typo'.",
                                s3: 'The request signature we calculated does not match the signature you provided. Check your key and signing method.',
                                elasticsearch: 'request to https://lahlahlemons.com:9243/_cat/indices/?format=json failed, reason: getaddrinfo ENOTFOUND lahlahlemons.com lahlahlemons.com:9243',
                                ['apache drill']: 'request to https://lahlahlemons.com:8047/query.json failed, reason: getaddrinfo ENOTFOUND lahlahlemons.com lahlahlemons.com:8047',
                                sqlite: 'SQLite file at path "typo" does not exist.'
                            })[connection.dialect]
                        }
                    });
                }
                assert.equal(res.status, 400);
                assert.deepEqual(
                    [],
                    getConnections(),
                    'connections weren\'t saved'
                );
                done();
            })).catch(done);

        });
    });

    it("connections - doesn't save connections if they already exist", function(done) {
        POST('connections', sqlConnections)
        .then(res => res.json().then(json => {
            assert.equal(res.status, 409);
            assert.deepEqual(json.connectionId, connectionId);
            done();
        })).catch(done);
    });

    it('connections - returns sanitized connections', function(done) {
        GET('connections')
        .then(res => {
            assert.equal(res.status, 200);
            return res.json();
        })
        .then(json => {
            assert.deepEqual(
                json.map(dissoc('id')),
                [dissoc('password', sqlConnections)]
            );
            done();
        }).catch(done);
    });

    it('connections - does not update connection if bad connection object', (done) => {
        PUT(`connections/${connectionId}`, assoc('username', 'banana', sqlConnections))
        .then(res => {
            assert.equal(res.status, 400);
            return res.json();
        })
        .then(json => {
            assert.deepEqual(
                json,
                {error: 'password authentication failed for user \"banana\"'}
            );
            assert.deepEqual(
                getConnections(),
                [merge(sqlConnections, {id: connectionId})]
            );
            done();
        }).catch(done);
    });

    it('connections - does not update connection if connectionId does not exist yet', (done) => {
        PUT('connections/wrong-connection-id-123', sqlConnections)
        .then(res => {

            assert.equal(res.status, 404);
            return res.json();
        })
        .then(json => {
            assert.deepEqual(
                json,
                {}
            );
            assert.deepEqual(
                getConnections(),
                [merge(sqlConnections, {id: connectionId})]
            );
            done();
        }).catch(done);
    });

    it('connections - updates connection if correct connection object', (done) => {
        PUT(`connections/${connectionId}`, mysqlConnection)
        .then(res => {
            assert.equal(res.status, 200);
            return res.json();
        })
        .then(json => {
            assert.deepEqual(
                json,
                {}
            );
            assert.deepEqual(
                getConnections(),
                [merge(mysqlConnection, {id: connectionId})]
            );
            done();
        }).catch(done);
    });

    it('connections - deletes connections', function(done) {
        assert.deepEqual(getConnections().map(dissoc('id')), [sqlConnections]);
        DELETE(`connections/${connectionId}`)
        .then(res => {
            assert.equal(res.status, 200);
            assert.deepEqual(getConnections(), []);
            done();
        }).catch(done);
    });

    it('connections - returns an empty array of connections', function(done) {
        fs.unlinkSync(getSetting('CONNECTIONS_PATH'));
        GET('connections')
        .then(res => {
            assert.equal(res.status, 200);
            return res.json();
        })
        .then(json => {
            assert.deepEqual(json, []);
            done();
        }).catch(done);
    });

    // Persistent Queries
    it('queries - registers a query and returns saved queries', function(done) {
        this.timeout(10 * 1000);
        // Verify that there are no queries saved
        GET('queries')
        .then(res => res.json())
        .then(json => {
            assert.deepEqual(json, []);

            // Save a grid that we can update
            return createGrid('test interval');

        })
        .then(res => {
            assert.equal(res.status, 201, 'Grid was created');
            return res.json();
        })
        .then(json => {
            const fid = json.file.fid;
            const uids = json.file.cols.map(col => col.uid);

            queryObject = {
                fid,
                uids,
                refreshInterval: 60,
                connectionId,
                query: 'SELECT * from ebola_2014 LIMIT 2'
            };
            return POST('queries', queryObject);
        })
        .then(res => res.json().then(json => {
            assert.deepEqual(json, {});
            assert.equal(res.status, 201, 'Query was saved');
            return GET('queries');
        }))
        .then(res => res.json())
        .then(json => {
            assert.deepEqual(json, [queryObject]);
        })
        .then(() => done())
        .catch(done);
    });

    it('queries - gets individual queries', function(done) {
        this.timeout(10 * 1000);
        GET(`queries/${queryObject.fid}`)
        .then(res => res.json().then(json => {
            assert.equal(res.status, 404);
            return POST('queries', queryObject);
        }))
        .then(res => res.json().then(json => {
            assert.deepEqual(json, {});
            assert.equal(res.status, 201);
            return GET(`queries/${queryObject.fid}`);
        }))
        .then(res => res.json().then(json => {
            assert.equal(res.status, 200);
            assert.deepEqual(json, queryObject);
            done();
        })).catch(done);
    });

    it('queries - deletes queries', function(done) {
        this.timeout(10 * 1000);
        POST('queries', queryObject)
        .then(() => DELETE(`queries/${queryObject.fid}`))
        .then(res => res.json().then(json => {
            assert.deepEqual(json, {});
            assert.equal(res.status, 200);
            return GET(`queries/${queryObject.fid}`);
        }))
        .then(res => {
            assert.equal(res.status, 404);
            done();
        }).catch(done);
    });

    it('queries - returns 404s when getting queries that don\'t exist', function(done) {
        this.timeout(10 * 1000);
        GET('queries/asdfasdf')
        .then(res => {
            assert.equal(res.status, 404);
            done();
        })
        .catch(done);
    });

    it('queries - returns 404s when deleting queries that don\'t exist', function(done) {
        DELETE('queries/asdfasdf')
        .then(res => {
            assert.equal(res.status, 404);
            done();
        })
        .catch(done);
    });

    it("queries - POST /queries fails when the user's API keys or oauth creds aren't saved", function(done) {
        this.timeout(10 * 1000);
        saveSetting('USERS', []);
        assert.deepEqual(getSetting('USERS'), []);
        POST('queries', queryObject)
        .then(res => res.json().then(json => {
            assert.deepEqual(
                json,
                {error: {
                    message: (
                        'Unauthenticated: Attempting to update grid ' +
                        'plotly-database-connector:197 ' +
                        'but the authentication credentials ' +
                        'for the user "plotly-database-connector" ' +
                        'do not exist.'
                    )
                }}
            );
            assert.equal(res.status, 500);
            done();
        })).catch(done);
    });

    it("queries - POST /queries fails when the user's API keys aren't correct", function(done) {
        this.timeout(10 * 1000);
        const creds = [{username: 'plotly-database-connector', apiKey: 'lah lah lemons'}];
        saveSetting('USERS', creds);
        assert.deepEqual(getSetting('USERS'), creds);
        POST('queries', queryObject)
        .then(res => res.json().then(json => {
            assert.deepEqual(
                json,
                {error: {
                    message: (
                        `Yikes! ${getSetting('PLOTLY_API_URL')} failed to identify ${username}. ` +
                        'These were the credentials supplied: ' +
                        `Username: ${creds[0].username}, API Key: ${creds[0].apiKey}, OAuth Access Token: ${creds[0].accessToken}.`
                    )
                }}
            );
            assert.equal(res.status, 400);
            done();
        })).catch(done);
    });

    // TODO - Getting intermittent FetchError: request to http://localhost:9494/queries failed, reason: socket hang up
    it("queries - POST /queries fails when it can't connect to the plotly server", function(done) {
        this.timeout(70 * 1000);
        const nonExistantServer = 'plotly.lah-lah-lemons.com';
        saveSetting('PLOTLY_API_DOMAIN', nonExistantServer);
        assert.deepEqual(getSetting('PLOTLY_API_URL'), `https://${nonExistantServer}`);
        POST('queries', queryObject)
        .then(res => res.json().then(json => {
            assert.deepEqual(
                json,
                {
                    error: {
                        message: (
                            'request to ' +
                            'https://plotly.lah-lah-lemons.com/v2/users/current ' +
                            'failed, reason: getaddrinfo ENOTFOUND plotly.lah-lah-lemons.com plotly.lah-lah-lemons.com:443'
                        )
                    }
                }
            );
            assert.equal(res.status, 400);
            done();
        })).catch(done);
    });

    it('queries - POST /queries fails when there is a syntax error in the query', function(done) {
        this.timeout(10 * 1000);
        const invalidQueryObject = merge(
            queryObject,
            {query: 'SELECZ'}
        );
        POST('queries', invalidQueryObject)
        .then(res => res.json().then(json => {
            assert.deepEqual(
                json,
                {error: {message: 'syntax error at or near "SELECZ"'}}
            );
            assert.equal(res.status, 400);
            done();
        })).catch(done);
    });

    it('uncaught-exceptions - uncaught exceptions get thrown OK ', function(done) {
        this.timeout(3 * 1000);
        POST('_throw')
        .then(res => res.json().then(json => {
            assert.equal(res.status, 500);
            assert.deepEqual(json, {error: {message: 'Yikes - uncaught error'}});
            done();
        })).catch(done);
    });

});
