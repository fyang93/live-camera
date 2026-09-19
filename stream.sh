#!/usr/bin/env bash
set -euo pipefail
sleep 1
# Live H.264 only. The player starts/stops a separate HEVC recorder on demand.
exec ffmpeg -hide_banner \
  -f v4l2 -input_format mjpeg -video_size 1920x1080 -framerate 20 -i /dev/video0 \
  -vf transpose=2 -an -c:v libx264 -preset veryfast -tune zerolatency \
  -crf 23 -maxrate 2M -bufsize 3M -pix_fmt yuv420p -g 20 -bf 0 \
  -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:8554/cam
