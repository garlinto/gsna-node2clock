/**
 * @file	/home/pi/gsna/js/sparkClock.js
 *
 * @desc	Use Particle's spark.js module to send/receive
 *        data from the photon to the clock and visa-versa.
 *
 * @date	2015-10-30
 *
 * List requires for this program
 */
"use strict";
var spark   = require('spark'),
    util    = require('util'),
    events	= require('events'),
    _       = require('lodash')
    sparkle = require('rapidus-sparkle'),
    sp      = require('serialport');

/**
 * Setup event processing
 */
var emitter = new events.EventEmitter();
emitterz
  .on("loggedIn", initComPort)
  .on("comReady", setRemoteEventHandlers)
  .on("handlersReady", getPhoton)
  .on("photon", callConfigClock)
  .on("gdState", setGdState)
  .on("clockConfigData", configureClock)
  .on("climateData", setClimateData)
  .on("cmdReady", queueCmd)
  .on("processCmd", tx)
  .on("cmdProcessed", function() {
    printToConsole("Command executed", "cmdSuccess");
    // call queueCmd again and set removePrev = true
    queueCmd(null, true);
  })
  .on("cmdRemoved", function(cmd) {
    printToConsole(util.format("Command [%s] removed from cmd queue", cmd));
    // call queueCmd again to process any further commands
    queueCmd();
  })
  .on("cmdResend", function() {
    printToConsole("Resending cmd", "error");
    queueCmd();
  })
  .on("writeError", function(error) {
    printToConsole(error, "error");
    printToConsole("Exiting application", debug);
    process.exit();
  })
  .on("RTC", function(str) {
    printToConsole(str, "serialIn");
  })
  .on("unhandledSerialData", function() {
    // do something
  });

//emitter.on("loggedIn", callClockConfigFunction);

/***********Login to Particle Cloud *****************
 * Configure the script by first
 *  logging in to the Particle cloud.
 */
const GSNA_PHOTON_1_ID = '370038000f47343339383037';
const ACCESS_TOKEN = 'e838e27702354f0b545233505e93a331566aa352';
// login to particl cloud
var loginPromise = spark.login({accessToken: ACCESS_TOKEN});
// Registering functions for promise resolve and reject.
loginPromise
  .then(
  function(token) {
    emitter.emit("loggedIn");
  },
  function(err) {
    printToConsole("API call to spark.login failed", "error");
  }
);

/************** Setup remote event handlers *********
 * Setup event handlers to process values
 *  emitted by the GSNA_Photon_1
 *  - gdState events
 *  - configure clock events
 *  - set climate events
 *  - set time events
 */

// define event handlers
function setRemoteEventHandlers() {
  // garage door state event handler
  spark.onEvent("gsna-gd-set-state-data", setGdState);
  spark.onEvent("gsna-gd-conf-clock", configureClock);
  spark.onEvent("gsna-gd-set-climate-data", setClimateData);
  emitter.emit('handlersReady');
}

// end setup remote event handlers

/******************GSNA_Photon_1 Device Object******
 * Retreive the GSNA_Photon_1's device object.
 * This is done by calling the device by it's id. This is then
 *  used to create remote function calls
 *  and publish/subscribe to events
 */
var photon;
function getPhoton() {
  spark.getDevice(GSNA_PHOTON_1_ID, function(error, device) {
    if (error) {
      printToConsole(error, "error");
    } else {
      photon = device;
      emitter.emit("photon");
    }
  });
}

// end get particle device object

/************* Call remote functions ************
 * Call remote functions that will emit events
 *  that will be caught by the event handlers
 *
 */
function callConfigClock() {
  if ('object' !== typeof(photon)) {
    throw Error("Valid particle device object was not passed");
  }

  photon.callFunction('gdRemoteCmd', "configure_clock", function(error, result) {
    if (error)
      printToConsole(error,"error");
  });
}

// end call remote functions

/******* Process Data from Subscribed Events ******
 * The event listeners configured above
 *  are setup to call the functions defined below.
 *
 */

// set the garage door state
function setGdState(/* object */ payload) {
  let json = JSON.parse(payload.data);
  let strCompiler = _.template('<%= cmd %> <%= s %>');
  var cmd = strCompiler(json);
  emitter.emit("cmdReady", cmd, false);
}

// send clock configuration cmd
function configureClock(/* object */ payload) {
  let json = JSON.parse(payload.data);
  let strCompiler = _.template('<%= cmd %> <%= e %> <%= t %> <%= p %> <%= s %>');
  var cmd = strCompiler(json);
  emitter.emit("cmdReady", cmd, false);
}

// send climate data to clock
function setClimateData(/* object */ payload) {
  let json = JSON.parse(payload.data);
  let strCompiler = _.template('<%= cmd %> <%= t %> <%= p %>');
  var cmd = strCompiler(json);
  emitter.emit("cmdReady", cmd, false);
}

/******** Configure Serial Port Communication *****
 * Get COM (serial) port object to communicate with
 *  teensy clock project.
 *
 */
var com,
    serial_port_config = {		// SerialPort configuration object
      baudrate: 9600,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      disconnectedCallback: function(error) {
        printToConsole(error, "error");
      }
    };

function initComPort() {
  /* var sp = require("serialport"); here for reference */
  sp.list(function (error, ports) {
    if (error) {
      printToConsole(error, "error");
    }

    ports.forEach(function(port) {
      if ('FTDI' === port.manufacturer) {
        var ComPort = sp.SerialPort;
        com = new ComPort(port.comName, serial_port_config, true, function(error) {
       		if (error)
       			printToConsole(error, "error");
       	});

        // serial port event handlers
        com
       		.on("open", function (error) {
       			if (error) {
              printToConsole(error, "error");
       				emitter.emit("serialPortError");
       			}
            emitter.emit('comReady');
       	  })
          .on("data", rx);

        // init command queue
        cmdQueue = [/* array of cmd strings */];

      }
    });
  });
}

// end initializing serial data

/*********** Process serial data *****************
 * Process received/transmitted
 *  serial data.
 *
 * Queue the command first, then process using
 *  a FIFO paradigm.
 */

// declare the cmdQueue variable (array)
var cmdQueue; // array initialized in initComPort();

// manage the cmdQueue
function queueCmd(/* string */ cmd, /* boolean */ removePrev) {
  if (true === _.isString(cmd)) {
    cmdQueue.push(cmd);
  }

  // check for commmands to process
  if (0 < cmdQueue.length) {
    // remove the previous command if removePrev === true
    if (true === _.isBoolean(removePrev) && true === removePrev) {
      var removed = cmdQueue.shift();
      emitter.emit("cmdRemoved", removed);
      return;
    }

    // made it here, process the first cmd string in array
    emitter.emit("processCmd", cmdQueue[0]);
  // no commands left to process
  } else {
    emitter.emit("cmdQueueEmpty");
  }
}

// transmit serial data
function tx(/* string */ data) {
  com.write(data, function(error, result) {
    if (error) {
      emitter.emit("writeError", error);
      return;
    }
    // success
    printToConsole(util.format("Cmd [%s] was written in [%d] bytes", data, result), "serialOut");
  });
}

// handle incoming serial data
function rx(/* Buffer */ data) {
  _.compact(data.toString().split(/\n/g)).forEach( function(line) {

    printToConsole(line, "serialIn");

    var resp_code =

    if (true === _.startsWith('RTC:', line)) {
      var str = result;
      result = "RTC";
    }

    switch(result) {
      case "100 0": // 0 errors
        emitter.emit("cmdProcessed");
        break;
      case "100 1": // 1 error
        emitter.emit("cmdResend");
        break;
      case "RTC":
        emitter.emit("rtcData", str);
        break;
      default:
        printToConsole(util.format("Unhandled serial data [%s]", result), "error");
        emitter.emit("unhandledSerialData");
        break;
    }
  });
}

/*************** Console Printing *****************
 * Configure the sparkle log formats
 */
var defaultFormat     = sparkle('%{white NOTICE\t%{white :str}}'),
    debugFormat       = sparkle('%{magenta DEBUG\t%{white :str}}'),
    errorFormat       = sparkle('%{bgRed ERROR\t%{white :str}}'),
    cmdSuccessFormat  = sparkle('%{green Cmd [}%{white :cmd}] executed'),
    particleOutFormat = sparkle('%{cyan PARTICLE <<\t%{white :str}}'),
    particleInFormat  = sparkle('%{bgCyan PARTICLE >>\t%{white :str}}'),
    mqttOutFormat     = sparkle('%{yellow MQTT <<\t%{white :str}}'),
    mqttInFormat      = sparkle('%{bgYellow %{white MQTT >>\t} %{red :str}}'),
    serialOutFormat   = sparkle('%{blue SERIAL <<\t%{white :str}}'),
    serialInFormat    = sparkle('%{bgBlue SERIAL >>\t%{white :str}}');
/**
 * Declare and define a print function
 *  that uses the format functions above to pretty print
 *  the log data to the console.
 */
function printToConsole(/* string */ print_str, /* string */ print_type) {

  var formatted = null;

  switch(print_type) {
    case 'error':
      if ('string' == typeof(print_str)) {
        formatted = errorFormat({str: print_str});
      } else {
        formatted = errorFormat({str: util.inspect(print_str, {showHidden: false, colors: true })});
      }
      break;
    case 'cmdSuccess':
      formatted = cmdSuccessFormat({cmd: print_str});
      break;
    case 'particleOut':
      formatted = particleOutFormat({str: print_str});
      break;
    case 'particleIn':
      //formatted = particleInFormat({str: print_str});
      formatted = particleInFormat({str: util.inspect(print_str, {showHidden: false, colors: true })});
      break;
    case 'mqttOut':
      formatted = mqttOutFormat({str: print_str});
      break;
    case 'mqttIn':
      formatted = mqttInFormat({str: print_str});
      break;
    case 'serialOut':
      formatted = serialOutFormat({str: print_str});
      break;
    case 'serialIn':
      formatted = serialInFormat({str: print_str});
      break;
    case 'debug':
      formatted = debugFormat({str: util.inspect(print_str, {showHidden: false, colors: true })});
      break;
    case 'notice':
    default:
      formatted = defaultFormat({str: print_str});
      break;
  }

  console.log(formatted);
}
