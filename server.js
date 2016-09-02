"use strict";

var express = require('express');
var util = require("util");
var request = require("request");
var fs = require("fs");
var PokemonGO = require('./node_modules/pokemon-go-node-api/poke.io.js');
var bodyParser = require('body-parser');

const CONFIG_FILE = "config.json";

var FILTERS;
var slack_token;

var hubdoc = new PokemonGO.Pokeio();
var logged_in = false;
var username;
var password;
var provider;

var interval;
var interval_id;

var longitude;
var latitude;
var altitude;
var location;
//location = { type: 'name', name: 'Eiffel Tower' };

var filters;
var excludes;

var start_logging;

var handle_request = function (param_text, callback) {
    try {
        var reply = { "text" : "I didn't understand that." };
        param_text = param_text.split(" ");
        param_text = param_text.filter( function (word) { return word !== ""; });
        console.log("Parsed command: " + util.inspect(param_text));

        if (!param_text.length) return callback(null, { "text" : "Type '/pgo help' for a list of instructions" });

        if (param_text[0] === "help") return callback(null, { "text" : "Help:\n"
                                                                        + "/pgo help - show this message\n"
                                                                        + "/pgo start - start watching for nearby Pokemon\n"
                                                                        + "/pgo stop - stop watching for nearby Pokemon\n"
                                                                        + "/pgo show - show list of Pokemon excluded from watchlist\n"
                                                                        + "/pgo exclude [name] - exclude a Pokemon from the watchlist\n"
                                                                        + "/pgo include [name] - put an excluded Pokemon back on the watchlist\n"
                                                                        + "/pgo coords - show current coordindates\n"
                                                                        + "/pgo coords [lng] [lat] [alt] - set current coordinates\n"
                                                                        + "/pgo interval - show current update interval (in ms)\n"
                                                                        + "/pgo interval [interval] - set the update interval to [interval]" });

        if (param_text[0] === "start") {
            if (!logged_in) {
                login(username, password, location, provider, function () {
                    read_excludes();
                    interval_id = start_logging(interval);
                });
            } else {
                read_excludes();
                interval_id = start_logging(interval);
            }
            return callback(null, { "text" : "Started watching for Pokemon. Let's Ketchum all!", "publish" : true });
        }

        if (param_text[0] === "stop") {
            clearInterval(interval_id);
            interval_id = null;
            save_excludes();
            return callback(null, { "text" : "Stopped watching for Pokemon.", "publish" : true });
        }

        if (param_text[0] === "show") {
            return callback(null, { "text" : "Pokemon you don't want reports on:\n" + util.inspect(excludes) });
        }

        if (param_text[0] === "exclude") {
            if (!param_text[1]) return callback(null, reply);
            var exclude = param_text[1];
            excludes.push(exclude);
            return callback(null, { "text" : "We won't be watching for " + exclude + " anymore.", "publish" : true });
        }

        if (param_text[0] === "include") {
            if (!param_text[1]) return callback(null, reply);
            var include = param_text[1];
            excludes = excludes.filter( function (pokemon) { return pokemon !== include; });
            return callback(null, { "text" : "We'll start watching for " + pokemon + " now.", "publish" : true });
        }

        if (param_text[0] === "coords") {
            if (!param_text[1]) return callback(null, { "text" : "I am at Longitude " + longitude + ", Latitude " + latitude + ", Altitude " + altitude + "." });
            if (!param_text[3]) return callback(null, reply);
            if (typeof param_text[1] !== "number" || typeof param_text[2] !== "number" || typeof param_text[3] !== "number")
                return callback(null, reply);
            longitude = parseFloat(param_text[1]);
            latitude = parseFloat(param_text[2]);
            altitude = parseFloat(param_text[3]);
            location = { type: 'coords', coords : { latitude : latitude, longitude : longitude, altitude : altitude }};
            hubdoc.SetLocation(location, function () {});
            return callback(null, { "text" : "FYI: Teleporting around too much will get me banned :(\n"
                                                + "I am at Longitude " + longitude + ", Latitude " + latitude + ", Altitude " + altitude + "." });
        }

        if (param_text[0] === "interval") {
            if (!param_text[1]) return callback(null, { "text" : "Current update interval (in ms) is " + interval + "." });
            interval = parseInt(param_text[1]);
            if (interval_id) clearInterval(interval_id);
            interval_id = start_logging(interval);
            return callback(null, { "text" : "Update interval is now " + interval + "ms.", "publish" : true });
        }

        return callback(null, reply);
    } catch (err) {
        console.log(util.inspect(err));
        return callback("Something's wrong", null);
    }
};

var publish_message = function (payload) {
    request( {
        url : "", // incoming webhook url for the pgo channel
        method : "POST",
        headers : { "Content-Type" : "application/json" },
        body : JSON.stringify(payload)
    }, function (err, res, body) {
        if (err) {
            console.log(err);
            throw err;
        }
    });
};

var app = express();

app.get("/", function (req, res) { 
    console.log(util.inspect(req.query));
    if (!req.query.token || req.query.token.valueOf() != slack_token.valueOf()) {
        console.log("Bad request!");
        return res.status(403).send("Bad request!");
    }

    var param_text = req.query.text;

    handle_request(param_text, function (err, reply) {
        if (err) return res.send({ "text" : "I am a broken bot :(" });
        if (reply.publish) publish_message(reply);
        return res.send(reply);
    });
});

app.listen(3000);

var login = function (username, password, location, provider, callback) {

    hubdoc.init(username, password, location, provider, function(err) {
        if (err) throw err;

        console.log('Current location: ' + hubdoc.playerInfo.locationName);
        console.log('lat/long/alt: : ' + hubdoc.playerInfo.latitude + ' ' + hubdoc.playerInfo.longitude + ' ' + hubdoc.playerInfo.altitude);

        hubdoc.GetProfile(function(err, profile) {
            if (err) throw err;

            console.log('Username: ' + profile.username);
            console.log('Poke Storage: ' + profile.poke_storage);
            console.log('Item Storage: ' + profile.item_storage);

            var poke = 0;
            if (profile.currency[0].amount) poke = profile.currency[0].amount;

            console.log('Pokecoin: ' + poke);
            console.log('Stardust: ' + profile.currency[1].amount);

            logged_in = true;


            start_logging = function (interval) {

                console.log("Logging with interval " + interval);
                var id = setInterval( function () {
                    hubdoc.Heartbeat( function (err, hb) {
                        if(err) console.log(err);

                        for (var i = hb.cells.length - 1; i >= 0; i--) {
                            if (hb.cells[i].NearbyPokemon[0]) {
                                var pokemon = hubdoc.pokemonlist[parseInt(hb.cells[i].NearbyPokemon[0].PokedexNumber)-1];
                                var distance = hb.cells[i].NearbyPokemon[0].DistanceMeters.toString();
                                var info = 'There is a ' + pokemon.name + ' nearby.';

                                if (excludes.indexOf(pokemon.name) > -1) {
                                    console.log("Excluding: " + info);
                                } else {
                                    console.log(info);
                                    publish_message({ "text" : info });
                                }
                            }
                        }
                    });
                }, interval);
                return id;
            }

            return callback();
        });
    });
};


var read_excludes = function () {
    fs.readFile(FILTERS, 'utf8', function (err, data) {
        if (err) throw err;

        console.log("Read from " + FILTERS);
        filters = JSON.parse(data);
        excludes = filters.excludes;
        console.log("Excludes:\n" + util.inspect(excludes));
    });
};


var save_excludes = function () {
    filters.excludes = excludes;
    var body = JSON.stringify(filters);
    console.log(body);
    fs.writeFile(FILTERS, body, function (err) {
        if (err) console.log(err);
    });
    excludes = null;
};

fs.readFile(CONFIG_FILE, function (err, data) {
    if (err) throw err;

    var config = JSON.parse(data);

    console.log(util.inspect(config));

    FILTERS = config.filter_file;
    slack_token = config.slack_token;
    interval = config.interval;
    username = config.username;
    password = config.password;
    provider = config.provider;
    longitude = config.longitude;
    latitude = config.latitude;
    altitude = config.altitude
    location = { type: 'coords', coords : { latitude : latitude, longitude : longitude, altitude : altitude }};
});
