var primaryPeerConnection = null;
var backupPeerConnection = null;
var vfdIntervalId = null;
var state = 0;

window.onbeforeunload = function() {
    if (primaryPeerConnection !== null) {
        primaryPeerConnection.close();
    }
};

/*function showFullscreenMessage() {
    if (state === 1) {
        var elem = document.getElementById('fullscreen-info-1');
    } else {
        var elem = document.getElementById('fullscreen-info-2');
    }
    elem.style.display = 'initial';
    setTimeout(function () {
        elem.style.display = 'none';
    }, 2000);
}*/

function attachStreamToVideoElement(pc, videoElem){
    console.log('Attaching stream...');
    var srcStream = new MediaStream();
    srcStream.addTrack(pc.getReceivers()[0].track);
    videoElem.srcObject = srcStream;
}

function peerConnectionGood(pc) {
    return ((pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed'));
}

function peerConnectionBad(pc) {
    return ((pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed'));
}

function hideAllContainers() {
    document.getElementById('spinner-container').style.display = 'none';
    document.getElementById('video-container').style.display = 'none';
    document.getElementById('fail-container').style.display = 'none';
    document.getElementById('mjpeg-container').style.display = 'none';
}

function showContainer(kind) {
    hideAllContainers();
    if (kind === 'video') {
        document.getElementById('video-container').style.display = 'block';
    } else if (kind === 'fail') {
        document.getElementById('fail-container').style.display = 'initial';
    } else if (kind === 'mjpeg') {
        document.getElementById('mjpeg-container').style.display = 'block';
    } else {
        console.error('No container that is kind of: ' + kind);
    }
}

function createNewPeerConnection() {
    var pc = new RTCPeerConnection(config);
    var isVideoAttached = false;
    new Promise(function (resolve, reject) {
        function mainIceListener() {
            console.warn(pc.iceConnectionState);
            if  (peerConnectionBad(pc)){
                if (state === 0) {
                    //this means webrtc connection is not possible
                    startMJPEG();
                }
                if (state !== 2) {
                    showContainer('fail');
                }
            }
            if (peerConnectionGood(pc)) {
                document.getElementById('video_state').text = 'WebRTC';
                if (!isVideoAttached) {
                    if (state === 0) {
                        state = 1;
                    }
                    isVideoAttached = true;
                    attachStreamToVideoElement(pc, document.getElementById('video'));
                    cleanup();
                    startVideoFreezeDetection(pc);
                }
                showContainer('video');
            }
        }
        pc.addEventListener('iceconnectionstatechange', mainIceListener);
        resolve();
    }).then(function () {
        pc.addTransceiver('video', {direction: 'recvonly'});
        return pc.createOffer()
    }).then(function(offer) {
        return pc.setLocalDescription(offer);
    }).then(function() {
        // wait for ICE gathering to complete
        return new Promise(function(resolve) {
            if (pc.iceGatheringState === 'complete') {
                resolve();
            } else {
                function checkState() {
                    if (pc.iceGatheringState === 'complete') {
                        pc.removeEventListener('icegatheringstatechange', checkState);
                        resolve();
                    }
                }
                pc.addEventListener('icegatheringstatechange', checkState);
            }
        });
    }).then(function() {
        var offer = pc.localDescription;
        console.log('Offer SDP');
        console.log(offer.sdp);
        return fetch('/offer', {
            body: JSON.stringify({
                sdp: offer.sdp,
                type: offer.type,
            }),
            headers: {
                'Content-Type': 'application/json'
            },
            method: 'POST'
        });
    }).then(function(response) {
        return response.json();
    }).then(function(answer) {
        console.log('Answer SDP');
        console.log(answer.sdp);
        return pc.setRemoteDescription(answer);
    }).catch(function(e){
        console.error(e);
        console.log('Unexpected Error: Starting MJPEG stream.')
        startMJPEG();
    });
    return pc
}

function supportsFullscreen() {
    return (document.body.mozRequestFullScreen || document.body.webkitRequestFullScreen || document.body.requestFullScreen);
}

function requestFullscreen(element) {
    return ((element.mozRequestFullScreen && element.mozRequestFullScreen()) ||
        (element.webkitRequestFullScreen && element.webkitRequestFullScreen()) ||
        (element.requestFullScreen && element.requestFullScreen()));
}

function fullscreen(elem) {
    if (elem === 1) {
        var video = document.getElementById('video');
    } else {
        var video = document.getElementById('mjpeg');
    }
    if (supportsFullscreen()) {
        setTimeout(requestFullscreen(video), 100);
    }
}

// Use on firefox
function getCurrentFrame() {
    var canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    var canvasContext = canvas.getContext("2d");
    canvasContext.drawImage(video, 0, 0);
    return canvas.toDataURL('image/png');
}

function isVideoFrozen(pc) {
    var previousFrame;
    var ignoreFirst = true;
    vfdIntervalId = setInterval(function() {
        if (peerConnectionGood(pc) && video.currentTime > 0 && getCurrentFrame() === previousFrame) {
            if (ignoreFirst) {
                ignoreFirst = false;
                return
            }
            console.warn("Video freeze detected using frames!!!");
            reconnect();
        } else {
            previousFrame = getCurrentFrame();
        }
    }, 3000);
}

// Use on Chrome
function checkVideoFreeze(pc) {
    var previousPlaybackTime;
    vfdIntervalId = setInterval(function() {
        if (peerConnectionGood(pc) && previousPlaybackTime === video.currentTime && video.currentTime !== 0) {
            console.warn("Video freeze detected!!!");
            reconnect();
        } else {
            previousPlaybackTime = video.currentTime;
        }
    }, 3000);
}

function startVideoFreezeDetection(pc) {
    stopVideoFreezeDetection();
    if (navigator.userAgent.toLowerCase().indexOf('firefox') > -1) {
        isVideoFrozen(pc);
    } else {
        checkVideoFreeze(pc);
    }
}

function stopVideoFreezeDetection() {
    if (vfdIntervalId !== null) {
        console.log('Stopping Current Video Freeze Detector');
        clearInterval(vfdIntervalId);
    }
}

function cleanup() {
    if (backupPeerConnection !== null) {
        console.log('Cleaning Up...')
        var tmp = primaryPeerConnection;
        primaryPeerConnection = backupPeerConnection;
        backupPeerConnection = tmp;
        backupPeerConnection.close();
        backupPeerConnection = null;
        var thisInterval = setInterval(function (){
            if (peerConnectionGood(primaryPeerConnection) && backupPeerConnection === null) {
                showContainer('video');
                clearInterval(thisInterval);
            }
        }, 100);
    }
}

function reconnect() {
    console.log('Reconnecting');
    backupPeerConnection = createNewPeerConnection();
}

function startMJPEG() {
    if (state !== 3) {
        primaryPeerConnection.close();
        primaryPeerConnection = null;
    }
    document.getElementById('video_state').text = 'MJPEG';
    console.warn('WebRTC does not work! Starting MJPEG streaming.')
    state = 2;

    var canvas = document.createElement("canvas");
    var ctx = canvas.getContext('2d');
    document.getElementById('mjpeg').appendChild(canvas);

    var mjpeg = new Image();
    mjpeg.id = 'mjpeg-image';
    mjpeg.src = '/mjpeg';
    mjpeg.style.visibility = 'hidden';
    mjpeg.style.position = 'absolute';
    document.getElementById('mjpeg').appendChild(mjpeg);

    mjpeg.onload = function() {
        canvas.style.width = mjpeg.width;
        canvas.style.height = mjpeg.height;
        canvas.width = mjpeg.width;
        canvas.height = mjpeg.height;
        var draw = setInterval(function() {
            try {
                ctx.drawImage(mjpeg, 0, 0);
            } catch (error) {
                console.error(error);
                console.warn('Stopping canvas draw.');
                clearInterval(draw);
                showContainer('fail');
            }
        }, 50);
    }

    showContainer('mjpeg');
}

var isSafari = !!navigator.userAgent.match(/Version\/[\d\.]+.*Safari/);
var iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
var safariOnIos = isSafari && iOS;
if (window.navigator.userAgent.indexOf("Edge") > -1  || safariOnIos) {
    //state 3 means the client is a Microsoft Edge or Safari on iOS
    state = 3;
    startMJPEG();
} else {
    var config = null;
    fetch('/ice-config').then(function(response) {
        return response.json();
    }).then(function(configData){
        config = configData;
        primaryPeerConnection = createNewPeerConnection();
    }).catch(function(e){
        console.error('Error while getting the ICE server configuration');
        console.error(e);
        state = 3;
        startMJPEG();
    });
}

var serverAddress = "localhost:8088/ws/mavlink?filter=HEARTBEAT|GPS_RAW_INT|VFR_HUD|SYS_STATUS|RC_CHANNELS_OVERRIDE"
var ws;
function ws_start(websocketServerLocation) {
    ws = new WebSocket(websocketServerLocation);

    ws.onconnect = function () {
        if (window.timerID) { /* a setInterval has been fired */
            window.clearTimeout(window.timerID);
            window.timerID = 0;
        }
    }
    // Handle received messages
    ws.onmessage = function (event) {
        try {
            var data = JSON.parse(event.data);
        } catch (error) {
            // on sending message we get non JSON response
            //console.log(error);
            //console.log(event.data);
        }
        if (data) {
            switch(data.type) {
                case "HEARTBEAT":
                    const mode_mapping_rover = {
                        0: 'MANUAL',
                        1: 'ACRO',
                        2: 'LEARNING',
                        3: 'STEERING',
                        4: 'HOLD',
                        5: 'LOITER',
                        6: 'FOLLOW',
                        7: 'SIMPLE',
                        10: 'AUTO',
                        11: 'RTL',
                        12: 'SMART_RTL',
                        15: 'GUIDED',
                        16: 'INITIALISING'
                    }
                    document.getElementById('state_state').text = mode_mapping_rover[data.custom_mode];
                    if (data.base_mode.bits & 128) {
                        document.getElementById('state_state').style.color = "green";
                    } else {
                        document.getElementById('state_state').style.color = "blue";
                    }
                    document.getElementById('vehicle').text = data.mavtype.type;

                    break;
                case "GPS_RAW_INT":
                    document.getElementById('gps_state').text = data.satellites_visible;
                    if (['GPS_FIX_TYPE_3D_FIX', 'GPS_FIX_TYPE_DGPS', 'GPS_FIX_TYPE_RTK_FLOAT', 'GPS_FIX_TYPE_RTK_FIXED'].includes(data.fix_type.type)) {
                        document.getElementById('gps_state').style.color = "green";
                    } else {
                        document.getElementById('gps_state').style.color = "red";
                    }
                    break;
                case "VFR_HUD":
                    document.getElementById('spd_state').text = data.groundspeed.toFixed(2);
                    document.getElementById('thr_state').text = data.throttle;
                    break;
                case "SYS_STATUS":
                    document.getElementById('battery_state').text = (data.voltage_battery * 0.001).toFixed(2) + "V/" + (data.current_battery * 0.01).toFixed(2) + "A";
                    break;
                default:
                // code block
            }
        }
    };
    ws.onclose = function (retry=true) {
        // Try to reconnect in 5 seconds
        ws = null;
        if (retry) {
            if (!window.timerID) { /* avoid firing a new setInterval, after one has been done */
                window.timerID = setTimeout(function () { ws_start(websocketServerLocation) }, 5000);
            }
        }
    };
}
ws_start("ws://" + serverAddress);
console.log("Current Server Address : " + serverAddress);

var joystick_manager = nipplejs.create({
    zone: document.getElementById('joystick'),
    color: 'blue',
    shape: "square",
    size: 200,
    threshold: 0.01,
});

var count = 0
var msg_sender
var mavlink_rc_msg = {
    header: {
        system_id: 255,
        component_id: 1,
        sequence: 0
    },
    message: {
        type:"RC_CHANNELS_OVERRIDE",
        target_system:1,
        target_component:1,
        chan1_raw:0,
        chan2_raw:0,
        chan3_raw:0,
        chan4_raw:0,
        chan5_raw:0,
        chan6_raw:0,
        chan7_raw:0,
        chan8_raw:0,
        chan9_raw:0,
        chan10_raw:0,
        chan11_raw:0,
        chan12_raw:0,
        chan13_raw:0,
        chan14_raw:0,
        chan15_raw:0,
        chan16_raw:0,
        chan17_raw:0,
        chan18_raw:0,
    }
};

joystick_manager.on('added', function (evt, nipple) {
    nipple.on('start', function (evt) {
        msg_sender = setInterval(function () {
            const json = JSON.stringify(mavlink_rc_msg);
            //console.log(json);
            ws.send(json);
        }, 100);
    });
    nipple.on('move', function (evt, data) {
        mavlink_rc_msg.header.sequence = count++;
        mavlink_rc_msg.message.chan3_raw = (((data.vector.y * 500.0) | 0) + 1500);
        mavlink_rc_msg.message.chan1_raw = (((data.vector.x * 500.0) | 0) + 1500);
    });

});

joystick_manager.on('removed', function (evt, nipple) {
    clearInterval(msg_sender);
    mavlink_rc_msg.header.sequence = count++;
    mavlink_rc_msg.message.chan1_raw = 0;
    mavlink_rc_msg.message.chan2_raw = 0;
    mavlink_rc_msg.message.chan3_raw = 0;
    mavlink_rc_msg.message.chan4_raw = 0;
    mavlink_rc_msg.message.chan5_raw = 0;
    mavlink_rc_msg.message.chan6_raw = 0;
    mavlink_rc_msg.message.chan7_raw = 0;
    mavlink_rc_msg.message.chan8_raw = 0;
    mavlink_rc_msg.message.chan9_raw = 0;
    mavlink_rc_msg.message.chan10_raw = 0;
    mavlink_rc_msg.message.chan11_raw = 0;
    mavlink_rc_msg.message.chan12_raw = 0;
    mavlink_rc_msg.message.chan13_raw = 0;
    mavlink_rc_msg.message.chan14_raw = 0;
    mavlink_rc_msg.message.chan15_raw = 0;
    mavlink_rc_msg.message.chan16_raw = 0;
    mavlink_rc_msg.message.chan17_raw = 0;
    mavlink_rc_msg.message.chan18_raw = 0;
    const json = JSON.stringify(mavlink_rc_msg);
    ws.send(json);
});
