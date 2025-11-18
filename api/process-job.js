// This is a Vercel Serverless Function running in a Node.js environment.
// It uses a native FFmpeg wrapper and a build script to ensure FFmpeg is available.

import { createClient } from '@supabase/supabase-js';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';

// Helper to create the subtitle file content
function createAssSubtitle(dialogue, audioDuration) {
  const totalWords = dialogue.reduce((sum, seg) => sum + (seg.line.split(/\s+/).filter(Boolean).length || 0), 0);
  const avgTimePerWord = totalWords > 0 ? audioDuration / totalWords : 0;
  let currentTime = 0;
  let events = '';
  const formatTime = (seconds) => {
      if (isNaN(seconds) || seconds < 0) seconds = 0;
      const date = new Date(seconds * 1000);
      const hours = String(date.getUTCHours()).padStart(1, '0');
      const minutes = String(date.getUTCMinutes()).padStart(2, '0');
      const secs = String(date.getUTCSeconds()).padStart(2, '0');
      const centiseconds = String(Math.floor(date.getUTCMilliseconds() / 10)).padStart(2, '0');
      return `${hours}:${minutes}:${secs}.${centiseconds}`;
  };
  for (const segment of dialogue) {
      let lineWithKaraokeTags = '';
      const words = segment.line.split(/\s+/).filter(Boolean);
      const segmentStartTime = currentTime;
      for (const word of words) {
          const wordDuration = avgTimePerWord;
          const karaokeTag = `{\\k${Math.round(wordDuration * 100)}}`;
          lineWithKaraokeTags += `${karaokeTag}${word} `;
          currentTime += wordDuration;
      }
      const segmentEndTime = currentTime;
      events += `Dialogue: 0,${formatTime(segmentStartTime)},${formatTime(segmentEndTime)},DefaultV2,,0,0,0,,${lineWithKaraokeTags.trim()}\n`;
  }
  return `[Script Info]\nTitle: Viral Clip Subtitles\nScriptType: v4.00+\n[V4+ Styles]\nStyle: DefaultV2,Arial,48,&H00FFFFFF,&H0000FFFF,&H00000000,&H99000000,-1,0,0,0,100,100,0,0,1,2,1,8,10,10,100,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events}`;
}

export default async function handler(request, response) {
    if (request.method !== 'POST') {
        return response.status(405).json({ error: 'Method Not Allowed' });
    }

    const { record: job } = request.body;
    if (!job) {
        return response.status(400).json({ error: 'Invalid payload from Supabase webhook.' });
    }

    const { audio_url: audioUrl, artwork_url: artworkUrl, dialogue, audio_duration: audioDuration, user_id: userId } = job.job_payload;
    const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Vercel provides a temporary writable file system at /tmp
    const tempDir = tmpdir();
    const audioPath = path.join(tempDir, 'audio.mp3');
    const artworkPath = path.join(tempDir, 'artwork.png');
    const subsPath = path.join(tempDir, 'subs.ass');
    const outputPath = path.join(tempDir, 'output.mp4');
    
    // This is the path where our install script places the FFmpeg binary
    const ffmpegPath = path.join(tempDir, 'ffmpeg', 'ffmpeg');


    try {
        await supabaseAdmin.from('video_jobs').update({ status: 'processing' }).eq('id', job.id);

        console.log('Downloading assets...');
        const [audioRes, artworkRes] = await Promise.all([ fetch(audioUrl), fetch(artworkUrl) ]);
        if (!audioRes.ok || !artworkRes.ok) throw new Error('Failed to download assets.');
        
        await fs.writeFile(audioPath, Buffer.from(await audioRes.arrayBuffer()));
        await fs.writeFile(artworkPath, Buffer.from(await artworkRes.arrayBuffer()));
        await fs.writeFile(subsPath, createAssSubtitle(dialogue, audioDuration));
        console.log('Assets downloaded and prepared.');

        // Tell fluent-ffmpeg where to find the binary our script downloaded
        ffmpeg.setFfmpegPath(ffmpegPath);

        console.log('Starting FFmpeg process...');
        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(artworkPath)
                .input(audioPath)
                .videoFilter(`scale=720:1280:force_original_aspect_ratio=decrease,boxblur=30:5,setsar=1,subtitles=${subsPath}:force_style='Fontsize=48,Alignment=8,MarginV=100'`)
                .outputOptions([
                    '-c:v libx264', '-tune stillimage', '-c:a aac', '-b:a 192k',
                    '-pix_fmt yuv420p', '-shortest', '-movflags +faststart'
                ])
                .on('end', () => { console.log('FFmpeg process finished.'); resolve(); })
                .on('error', (err) => { console.error('FFmpeg error:', err); reject(new Error(`FFmpeg processing failed: ${err.message}`)); })
                .save(outputPath);
        });
        
        console.log('Uploading video to storage...');
        const videoData = await fs.readFile(outputPath);
        const filePath = `${userId}/clips/${Date.now()}-viral-clip.mp4`;

        const { error: uploadError } = await supabaseAdmin.storage.from('viral-clips').upload(filePath, videoData, { contentType: 'video/mp4' });
        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabaseAdmin.storage.from('viral-clips').getPublicUrl(filePath);
        console.log('Upload complete.');
        
        await supabaseAdmin.from('video_jobs').update({ status: 'complete', video_url: publicUrl }).eq('id', job.id);

        return response.status(200).json({ success: true, videoUrl: publicUrl });

    } catch (error) {
        console.error('Video processing error:', error);
        await supabaseAdmin.from('video_jobs').update({ status: 'failed', error_message: error.message }).eq('id', job.id);
        return response.status(500).json({ error: error.message });
    } finally {
        // Clean up temporary files
        Promise.all([fs.unlink(audioPath), fs.unlink(artworkPath), fs.unlink(subsPath), fs.unlink(outputPath)]).catch(console.error);
    }
}