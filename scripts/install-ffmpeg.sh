#!/bin/bash
set -e # Exit immediately if a command exits with a non-zero status.

echo "Starting FFmpeg installation..."

# Define the directory for FFmpeg
FFMPEG_DIR="/tmp/ffmpeg"
mkdir -p $FFMPEG_DIR

# Download and extract a static build of FFmpeg for the Vercel (Linux x64) environment.
echo "Downloading FFmpeg static build..."
curl "https://johnvansickle.com/ffmpeg/builds/ffmpeg-git-amd64-static.tar.xz" | tar -xJ -C $FFMPEG_DIR --strip-components=1

# CRITICAL: Grant execute permissions to the downloaded binary.
chmod +x $FFMPEG_DIR/ffmpeg

echo "FFmpeg installed and made executable at $FFMPEG_DIR"