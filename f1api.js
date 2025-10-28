const express = require('express')
const axios = require('axios')
const cors = require('cors')
const rateLimit = require('express-rate-limit');
const path = require('path');
const { Redis } = require('@upstash/redis')

require('dotenv').config()

var trackinfo = require("./trackinfo")
var weather_icons = require("./icons")
var teamcolors = require("./teamcolors")

const app = express()
const F1apiURL = "https://api.jolpi.ca/ergast/f1"
var yearoverwrite = null;

const redis = Redis.fromEnv()

const allowed_origins = [
    'chrome-extension://kcnpkcgkeoeaecmalnnhioaoghbmmlcd',
    'chrome-extension://gibolpjfgmianecgomfpkddkgajnnpgb'
]

function Cache(ttlMs) {
    return async (req, res, next) => {
        try {
            const key = `cache:${req.originalUrl}`;

            const cached = await redis.get(key);
            if (cached) {
                return res.json(cached);
            }

            // Capture the JSON response
            const originalJson = res.json.bind(res);
            res.json = async (body) => {
            await redis.set(key, body, { ex: Math.floor(ttlMs / 1000) }); // expire after ttlMs
            originalJson(body);
            };    

            next();
        } catch (err) {
            console.error("Cache error:", err);
            next();
        }
    };
}

app.use(express.json())
app.use(cors({
    origin: (origin, callback) => {
        console.log("CORS request from origin:", origin);
        if (!origin || allowed_origins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"]
}))

app.use(rateLimit({
    windowMs: 8 * 1000,
    max: 75,
    message: {"error":"Too many requests, please try again later."}
}))

var lowRateLimit = rateLimit({
    windowMs: 1 * 60 * 60 * 1000,
    max: 5, // Max 5 requests in 1 hour
    message: {"error":"Too many requests, please try again later."}
})

app.post("/feedback", lowRateLimit, async (req, res) => {
    if (!req.body) {
        return res.status(400).json({"error":"missing body"})
    }

    var feedback = {
        "info": req.body.info,
        "contact": req.body.contact,
        "version": req.body.version,
        "browser": req.body.browser,
        "locale": req.body.locale,
    }

    console.log("Feedback received:", feedback)

    const discordMessage = {
        embeds: [{
            title: "📩 New Feedback Received",
            color: 0x00BFFF,
            fields: [
                { name: "Info", value: feedback.info || "N/A" },
                { name: "Contact", value: feedback.contact || "N/A" },
                { name: "Version", value: feedback.version || "N/A" },
                { name: "Browser", value: feedback.browser || "N/A" },
                { name: "Locale", value: feedback.locale || "N/A" },
                { name: "User Agent", value: req.headers['user-agent'] || "N/A" },
                { name: "Date", value: new Date().toLocaleString('nl-NL', {timeZone: 'Europe/Amsterdam'}) }
            ]
        }]
    }

    try {
        var WEBHOOK_URL = process.env.WEBHOOK_URL
        await axios.post(WEBHOOK_URL, discordMessage)
    } catch (error) {
        console.error("Error sending feedback to Discord:", error.message)
    }
    res.status(200).json()
})


//15 minutes cache for weather
app.get("/forecast", Cache(15 * 60 * 1000), async (req, res) => {
    if (!req.query.lat || !req.query.lon || !req.query.date) {
        return res.status(400).json({"error":"missing query params"})
    }

    var date = new Date(`${req.query.date}`)
    var date2 = new Date(`${req.query.date}`)
    date2.setUTCDate(date.getUTCDate() + 1)

    const quarters = (date.getUTCHours() * 60 + date.getUTCMinutes()) / 15

    const params = {
        "latitude": req.query.lat,
        "longitude": req.query.lon,
        "minutely_15": ["temperature_2m", "precipitation", "weather_code"],
        "timezone": "GMT",
        "start_date": date.toISOString().split("T")[0],
        "end_date": date2.toISOString().split("T")[0],
    };

    try {
        var response = await axios.get(`https://api.open-meteo.com/v1/forecast`, {params: params});
    } catch (error) {
        console.log(error)
        return res.status(204).json({"error": "Error occured"})
    }

    var responseobj = [
        {
            "time": response.data.minutely_15.time[quarters],
            "temp": response.data.minutely_15.temperature_2m[quarters],
            "icon": weather_icons[response.data.minutely_15.weather_code[quarters]]
        },
        {
            "time": response.data.minutely_15.time[quarters+2],
            "temp": response.data.minutely_15.temperature_2m[quarters+2],
            "icon": weather_icons[response.data.minutely_15.weather_code[quarters+2]]
        },
        {
            "time": response.data.minutely_15.time[quarters+4],
            "temp": response.data.minutely_15.temperature_2m[quarters+4],
            "icon": weather_icons[response.data.minutely_15.weather_code[quarters+4]]
        }
    ]

    for (var i = 0; i < responseobj.length; i++) {
        if (responseobj[i].temp == null || responseobj[i].icon == null) {
            return res.status(204).json()
        }
    }

    res.status(200).json(responseobj)
})

app.get("/heartbeat", async (req, res) => {
    console.log(`Heartbeat request [${new Date().toLocaleString('nl-NL', {timeZone: 'Europe/Amsterdam'})}]`)
    res.status(200).json({"status":"success"})
})

//30 days cache for track images
app.get("/track-image/:circuitId", Cache(20 * 24 * 60 * 60 * 1000), async (req, res) => {
    res.status(200).sendFile(path.join(__dirname, '.', 'tracks', `${req.params.circuitId}.png`))
})

//30 days cache for track info
app.get("/track-info/:circuitId", Cache(20 * 24 * 60 * 60 * 1000), async (req, res) => {
    if (trackinfo[req.params.circuitId]) {
        res.status(200).json(trackinfo[req.params.circuitId])
    } else {
        res.status(204).json()
    }
})

//30 days cache for spolier sessions
app.get("/spoilersessions", Cache(20 * 24 * 60 * 60 * 1000), async (req, res) => {
    var year = new Date().getFullYear()
    if (yearoverwrite) {year = yearoverwrite}

    var response = await axios.get(`${F1apiURL}/${year}/races`);

    var spoilertimes = []

    for (var i = 0; i < response.data.MRData.RaceTable.Races.length; i++) {
        var race = response.data.MRData.RaceTable.Races[i]

        if (race.Sprint) {
            spoilertimes.push(Math.floor(Date.parse(`${race.Sprint.date} ${race.Sprint.time}`).valueOf() / 1000))
        }
        spoilertimes.push(Math.floor(Date.parse(`${race.date} ${race.time}`).valueOf() / 1000))

        sessions = {FP1: race.FirstPractice, FP2: race.SecondPractice, FP3: race.ThirdPractice, "SQ's": race.SprintQualifying, Sprint: race.Sprint, "Q's": race.Qualifying, "Race": {"date": race.date, "time": race.time}}
    }

    res.status(200).json({"spoilersessions": spoilertimes})
})

//10 mins cache for constructor standings
app.get("/constructors", Cache(10 * 60 * 1000), async (req, res) => {
    var year = new Date().getFullYear()
    if (yearoverwrite) {year = yearoverwrite}
    var response = await axios.get(`${F1apiURL}/${year}/constructorstandings`);

    var responseobj = []

    if (response.data.MRData.StandingsTable.StandingsLists.length == 0) {
        return res.status(204).json()
    }

    if (response.data.MRData.StandingsTable.round > 1) {
        var lastround = response.data.MRData.StandingsTable.round - 1

        var lastroundResponse = await axios.get(`${F1apiURL}/${year}/${lastround}/constructorstandings`)

        var lastroundDict = lastroundResponse.data.MRData.StandingsTable.StandingsLists[0].ConstructorStandings.reduce((acc, standing) => {
            acc[standing.Constructor.constructorId] = parseInt(standing.position);
            return acc;
          }, {});
    }

    for (var i = 0; i < response.data.MRData.StandingsTable.StandingsLists[0].ConstructorStandings.length; i++) {
        var constructor = response.data.MRData.StandingsTable.StandingsLists[0].ConstructorStandings[i]

        constructor.position = parseInt(constructor.position)

        if (lastroundDict) {
            if (constructor.points == 0) {
                var change = "EQ"
            } else if (lastroundDict[constructor.Constructor.constructorId] < constructor.position) {
                var change = "NEG"
            } else if (lastroundDict[constructor.Constructor.constructorId] > constructor.position) {
                var change = "POS"
            } else {
                var change = "EQ"
            }
        } else {
            var change = "EQ"
        }


        responseobj.push({
            position: constructor.position,
            name: constructor.Constructor.name,
            nationality: constructor.Constructor.nationality,
            points: constructor.points,
            wins: constructor.wins,
            change: change
        })
    }

    res.status(200).json(responseobj)
})

//10 mins cache for driver standings
app.get("/drivers", Cache(10 * 60 * 1000), async (req, res) => {
    var year = new Date().getFullYear()
    if (yearoverwrite) {year = yearoverwrite}
    var response = await axios.get(`${F1apiURL}/${year}/driverstandings`);

    var responseobj = []

    if (response.data.MRData.StandingsTable.StandingsLists.length == 0) {
        return res.status(204).json();
    }

    //get last round standings if possible
    if (response.data.MRData.StandingsTable.round > 1) {
        var lastround = response.data.MRData.StandingsTable.round - 1

        var lastroundResponse = await axios.get(`${F1apiURL}/${year}/${lastround}/driverstandings`)

        var lastroundDict = lastroundResponse.data.MRData.StandingsTable.StandingsLists[0].DriverStandings.reduce((acc, standing) => {
            acc[standing.Driver.driverId] = parseInt(standing.position);
            return acc;
          }, {});
    }

    for (var i = 0; i < response.data.MRData.StandingsTable.StandingsLists[0].DriverStandings.length; i++) {
        var driver = response.data.MRData.StandingsTable.StandingsLists[0].DriverStandings[i]

        driver.position = parseInt(driver.position)

        //get last round position and define change
        if (lastroundDict) {
            if (driver.points == 0) {
                var change = "EQ"
            } else if (lastroundDict[driver.Driver.driverId] < driver.position) {
                var change = "NEG"
            } else if (lastroundDict[driver.Driver.driverId] > driver.position) {
                var change = "POS"
            } else {
                var change = "EQ"
            }
        } else {
            var change = "EQ"
        }

        responseobj.push({
            position: driver.position,
            name: `${driver.Driver.givenName} ${driver.Driver.familyName}`,
            code: driver.Driver.code,
            nationality: driver.Driver.nationality,
            points: driver.points,
            wins: driver.wins,
            change: change, 
            constructor: driver.Constructors[driver.Constructors.length - 1].name
        })
    }

    res.status(200).json(responseobj)
})

cached_constructors_data = {
    round: 0,
    labels: ["Data loading...", "Data loading...", "Data loading..."],
    datasets: [
        {
            label: "Server is fetching data",
            data: [1, 2, 3],
            borderColor: "#d6261a",
            backgroundColor: "#d6261a",
        },
        {
            label: "Server is fetching data",
            data: [0, 1, 2],
            borderColor: "#d6261a",
            backgroundColor: "#d6261a",
        }
    ]
}

//30 mins cache for constructor graph data
app.get("/constructors/graph-data", Cache(30 * 60 * 1000), async (req, res) => {
    var year = new Date().getFullYear()
    if (yearoverwrite) {year = yearoverwrite}
    var response = await axios.get(`${F1apiURL}/${year}/last`);

    if (response.data.MRData.RaceTable.round == 0) {
        year--;
        var response = await axios.get(`${F1apiURL}/${year}/last`);
    }

    if (cached_constructors_data.round == response.data.MRData.RaceTable.round) {
        console.log("Returning cached constructor graph data")
        return res.status(200).json(cached_constructors_data)
    } else {
        console.log("Updating constructor graph data cache")
        update_constructors_graph_data(response.data.MRData.RaceTable.round, year);
        return res.status(200).json(cached_constructors_data)
    }
})

async function update_constructors_graph_data(rounds, year) {
    var responseobj = {
        round: rounds,
        labels: [],
        datasets: []
    }
    for (var i = 1; i <= rounds; i++) {
        var roundResponse = await axios.get(`${F1apiURL}/${year}/${i}/constructorstandings`)

        responseobj.labels.push(`Round ${i}`)

        for (var j = 0; j < roundResponse.data.MRData.StandingsTable.StandingsLists[0].ConstructorStandings.length; j++) {
            var constructor = roundResponse.data.MRData.StandingsTable.StandingsLists[0].ConstructorStandings[j]

            if (!responseobj.datasets.find(dataset => dataset.id == constructor.Constructor.constructorId)) {
                responseobj.datasets.push({
                    id: constructor.Constructor.constructorId,
                    label: constructor.Constructor.name,
                    borderColor: teamcolors[constructor.Constructor.name] || "#FFFFFF",
                    backgroundColor: teamcolors[constructor.Constructor.name] || "#FFFFFF",
                    data: new Array(i-1).fill("0"),
                    borderWidth: 1,
                })
            }

            responseobj.datasets.find(dataset => dataset.id == constructor.Constructor.constructorId).data.push(constructor.points)
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    cached_constructors_data = responseobj;
    return;
}

cached_drivers_data = {
    round: 0,
    labels: ["Data loading...", "Data loading...", "Data loading..."],
    datasets: [
        {
            label: "Server is fetching data",
            data: [1, 2, 3],
            borderColor: "#d6261a",
            backgroundColor: "#d6261a",
        },
        {
            label: "Server is fetching data",
            data: [0, 1, 2],
            borderColor: "#d6261a",
            backgroundColor: "#d6261a",
        }
    ]
}

//30 mins cache for driver graph data
app.get("/drivers/graph-data", Cache(30 * 60 * 1000), async (req, res) => {
    var year = new Date().getFullYear()
    if (yearoverwrite) {year = yearoverwrite}
    var response = await axios.get(`${F1apiURL}/${year}/last`);

    if (response.data.MRData.RaceTable.round == 0) {
        year--;
        var response = await axios.get(`${F1apiURL}/${year}/last`);
    }

    if (cached_drivers_data.round == response.data.MRData.RaceTable.round) {
        console.log("Returning cached driver graph data")
        return res.status(200).json(cached_drivers_data)
    } else {
        console.log("Updating driver graph data cache")
        drivers_graph_data(response.data.MRData.RaceTable.round, year);
        return res.status(200).json(cached_drivers_data)
    }
})

async function drivers_graph_data(rounds, year) {
    var responseobj = {
        round: rounds,
        labels: [],
        datasets: []
    }

    for (var i = 1; i <= rounds; i++) {
        var roundResponse = await axios.get(`${F1apiURL}/${year}/${i}/driverstandings`)

        responseobj.labels.push(`Round ${i}`)

        for (var j = 0; j < roundResponse.data.MRData.StandingsTable.StandingsLists[0].DriverStandings.length; j++) {
            var driver = roundResponse.data.MRData.StandingsTable.StandingsLists[0].DriverStandings[j]

            if (!responseobj.datasets.find(dataset => dataset.id == driver.Driver.driverId)) {
                responseobj.datasets.push({
                    id: driver.Driver.driverId,
                    team: driver.Constructors[driver.Constructors.length - 1].name,
                    label: `${driver.Driver.givenName} ${driver.Driver.familyName}`,
                    data: new Array(i-1).fill("0"),
                    borderWidth: 1,
                })
            }

            responseobj.datasets.find(dataset => dataset.id == driver.Driver.driverId).data.push(driver.points)
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    var teams = []
    responseobj.datasets.sort((a,b) => b.data.at(-1) - a.data.at(-1));

    for (var i = 0; i < responseobj.datasets.length; i++) {
        var driver = responseobj.datasets[i]

        driver.borderColor = teamcolors[driver.team] || "#FFFFFF"
        driver.backgroundColor = teamcolors[driver.team] || "#FFFFFF"
        if (!teams.includes(driver.team)) {
            teams.push(driver.team)
        } else {
            driver.borderDash = [5, 3]
        }
    }
    cached_drivers_data = responseobj;
    return;
}

//10 mins cache for schedule
app.get("/schedule", Cache(10 * 60 * 1000), async (req,res) => {
    var year = new Date().getFullYear()
    if (yearoverwrite) {year = yearoverwrite}
    var response = await axios.get(`${F1apiURL}/${year}/races`);

    var responseobj = []

    for (var i = 0; i < response.data.MRData.RaceTable.Races.length; i++) {
        var race = response.data.MRData.RaceTable.Races[i]

        var racedate = Date.parse(`${race.date} ${race.time}`)
        if (racedate < new Date()) {
            continue
        }

        responseobj.push({
            round: race.round,
            raceName: race.raceName,
            circuit: race.Circuit,
            date: race.date,
            time: race.time,
            sessions: {FP1: race.FirstPractice, FP2: race.SecondPractice, FP3: race.ThirdPractice, "SQ's": race.SprintQualifying, Sprint: race.Sprint, "Q's": race.Qualifying}
        })
    }

    res.status(200).json(responseobj)
})

//10 mins cache for latest
app.get("/latest", Cache(10 * 60 * 1000), async (req,res) => {
    var year = new Date().getFullYear()
    if (yearoverwrite) {year = yearoverwrite}
    var response = await axios.get(`${F1apiURL}/${year}/last/results`);

    if (response.data.MRData.RaceTable.Races.length == 0) {
        year--;
        var response = await axios.get(`${F1apiURL}/${year}/last/results`);
    }

    var responseobj = {
        round: response.data.MRData.RaceTable.Races[0].round,
        name: response.data.MRData.RaceTable.Races[0].raceName,
        circuit: response.data.MRData.RaceTable.Races[0].Circuit,
        drivers: []
    }

    for (var i = 0; i < response.data.MRData.RaceTable.Races[0].Results.length; i++) {
        var driver = response.data.MRData.RaceTable.Races[0].Results[i]

        responseobj.drivers.push({
            position: driver.position,
            points: driver.points,
            name: `${driver.Driver.givenName} ${driver.Driver.familyName}`,
            code: driver.Driver.code,
            constructor: driver.Constructor.name,
            status: driver.status,
            laps: driver.laps,
            totalTime: driver.Time,
            fastestLap: driver.FastestLap
        });
    }

    res.status(200).json(responseobj)
});

//10 mins cache for qualifying
app.get("/qualifying/:round", Cache(10 * 60 * 1000), async (req,res) => {
    var year = new Date().getFullYear()
    if (yearoverwrite) {year = yearoverwrite}
    var response = await axios.get(`${F1apiURL}/${year}/${req.params.round}/qualifying`);

    if (response.data.MRData.RaceTable.Races.length == 0) {
        return res.status(204).json('none')
    }

    var responseobj = []

    for (var i = 0; i < response.data.MRData.RaceTable.Races[0].QualifyingResults.length; i++) {
        var qualifyer = response.data.MRData.RaceTable.Races[0].QualifyingResults[i]

        responseobj.push({
            position: qualifyer.position,
            name: `${qualifyer.Driver.givenName} ${qualifyer.Driver.familyName}`,
            code: qualifyer.Driver.code,
            constructor: qualifyer.Constructor.name,
            Q1: qualifyer.Q1,
            Q2: qualifyer.Q2,
            Q3: qualifyer.Q3
        })
    }

    res.status(200).json(responseobj);
});

app.listen(4999, () => {
    console.log('listening on port 4999')
})