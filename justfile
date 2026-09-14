set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

default:
    @just --list

# Preflight checks.
check:
    #!/usr/bin/env bash
    set -euo pipefail

    echo "== Checking dependencies =="

    for cmd in zellij mediamtx ffmpeg ffprobe v4l2-ctl ss bun; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            echo "ERROR: missing command: $cmd"
            exit 1
        fi
        echo "OK: $cmd"
    done

    echo
    echo "== Checking camera =="

    DEVICE="/dev/video0"

    if [[ ! -e "$DEVICE" ]]; then
        echo "ERROR: $DEVICE not found"
        exit 1
    fi

    if ! v4l2-ctl -d "$DEVICE" --all >/dev/null 2>&1; then
        echo "ERROR: $DEVICE exists but is not responding"
        exit 1
    fi

    echo "OK: $DEVICE is responding"

    echo
    echo "== Checking camera format =="

    FORMATS="$(v4l2-ctl -d "$DEVICE" --list-formats-ext)"

    if ! grep -q "'MJPG'" <<< "$FORMATS"; then
        echo "ERROR: camera does not advertise MJPEG support"
        exit 1
    fi

    if ! grep -q "1920x1080" <<< "$FORMATS"; then
        echo "ERROR: camera does not advertise 1920x1080 support"
        exit 1
    fi

    echo "OK: MJPEG 1920x1080 is available"

    echo
    echo "== Checking ports =="

    for port in 8554 8889 8189 8080; do
        if ss -lntup 2>/dev/null | grep -qE ":${port}([[:space:]]|$)"; then
            echo "ERROR: port $port is already in use"
            exit 1
        fi

        echo "OK: port $port is free"
    done

    echo
    echo "== Checking Zellij session =="

    if zellij list-sessions --short --no-formatting 2>/dev/null | grep -Fxq "live-camera"; then
        echo "ERROR: Zellij session 'live-camera' already exists"
        echo
        echo "Stop it with:"
        echo "  just stop"
        exit 1
    fi

    echo "OK: no existing live-camera session"

    echo
    echo "All checks passed."

# Start live video; recording is OFF until enabled in the UI. Segment length: 1–12 hours.
live ip="127.0.0.1" segment_hours="2" codec="h265": stop check
    #!/usr/bin/env bash
    set -euo pipefail

    case "{{codec}}" in
        h265|h264) ;;
        *) echo "ERROR: recording codec must be h265 or h264"; exit 1 ;;
    esac
    HOURS="{{segment_hours}}"
    if ! [[ "$HOURS" =~ ^([1-9]|1[0-2])$ ]]; then
        echo "ERROR: segment_hours must be an integer from 1 to 12"
        exit 1
    fi
    SEGMENT_SECONDS=$((HOURS * 3600))

    TMPDIR="$(mktemp -d /tmp/live-camera.XXXXXX)"
    trap 'rm -rf "$TMPDIR"' EXIT

    echo "Player: http://{{ip}}:8080/"
    echo "Live: H.264 / 1080p / 30 fps; manual recording: {{codec}} / 1080p / 20 fps"
    echo "Recording is OFF. Enable it in the player; files roll every ${HOURS} hours."
    echo "Saved recordings: $PWD/recordings/"
    echo

    cat > "$TMPDIR/mediamtx.yml" <<EOF
    logLevel: info

    rtsp: true
    rtspAddress: 127.0.0.1:8554
    rtspTransports: [tcp]
    rtmp: false
    srt: false
    moq: false

    hls: false

    webrtc: true
    webrtcAddress: 127.0.0.1:8889
    webrtcLocalUDPAddress: :8189
    webrtcAdditionalHosts:
      - {{ip}}

    paths:
      cam:
        source: publisher
    EOF

    cat > "$TMPDIR/live-camera.kdl" <<EOF
    layout {
        tab name="camera" {
            pane split_direction="vertical" {
                pane name="Player" command="env" {
                    args "RECORDING_CODEC={{codec}}" "RECORDING_SEGMENT_SECONDS=$SEGMENT_SECONDS" "bun" "$PWD/web/server.ts"
                }

                pane name="MediaMTX" command="mediamtx" {
                    args "$TMPDIR/mediamtx.yml"
                }

                pane name="FFmpeg" command="bash" {
                    args "$PWD/stream.sh"
                }
            }
        }
    }
    EOF

    exec zellij \
        --session live-camera \
        --new-session-with-layout "$TMPDIR/live-camera.kdl"

# Stop the live-camera session.
stop:
    #!/usr/bin/env bash
    set -euo pipefail

    if zellij list-sessions --short --no-formatting 2>/dev/null | grep -Fxq "live-camera"; then
        # Finish the current MP4 before terminating its server and the camera.
        bun "$PWD/web/stop-recording.ts" || echo "WARN: could not gracefully stop recording; interrupted files will be recovered."
        zellij delete-session --force live-camera
        echo "Stopped live-camera."
    else
        echo "live-camera is not running."
    fi
