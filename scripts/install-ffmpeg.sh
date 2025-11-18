#!/bin/bash
set -e # Exit immediately if a command exits with a non-zero status.

echo "Starting FFmpeg installation..."

# Define the directory for FFmpeg
FFMPEG_DIR="/tmp/ffmpeg"
mkdir -p $FFMPEG_DIR

# Download and extract a static build of FFmpeg
# This is a known-good build for Linux x64, which is what Vercel runs on.
curl "https://johnvansickle.com/ffmpeg/builds/ffmpeg-git-amd64-static.tar.xz" | tar -xJ -C $FFMPEG_DIR --strip-components=1

echo "FFmpeg installed successfully at $FFMPEG_DIR"