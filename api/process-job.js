// This is a Vercel Serverless Function running in a Node.js environment.

import { createClient } from '@supabase/supabase-js';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

// Helper to create the subtitle file content
function createAssSubtitle(dialogue, audioDuration) {
  const totalWords = dialogue.reduce((sum, seg) => sum + seg.line.split(/\s+/).filter(Boolean).length, 0);
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
  return `[Script Info]
Title: Viral Clip Subtitles
ScriptType: v4.00+
[V4+ Styles]
Style: DefaultV2,Arial,48,&H00FFFFFF,&H0000FFFF,&H00000000,&H99000000,-1,0,0,0,100,100,0,0,1,2,1,8,10,10,100,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}`;
}

export default async function handler(request, response) {
  // Vercel automatically parses the body for POST requests
  const { record: job } = request.body;
  if (!job) {
    return response.status(400).json({ error: 'Invalid payload from Supabase webhook.' });
  }

  const {
    audio_url: audioUrl,
    artwork_url: artworkUrl,
    dialogue,
    audio_duration: audioDuration,
    user_id: userId
  } = job.job_payload;

  const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    // 1. Update job status to 'processing'
    await supabaseAdmin.from('video_jobs').update({ status: 'processing' }).eq('id', job.id);

    // 2. Load FFmpeg and files
    const ffmpeg = new FFmpeg();
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
    const coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript');
    const wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm');
    await ffmpeg.load({ coreURL, wasmURL });

    const [audioData, artworkData] = await Promise.all([
      fetchFile(audioUrl),
      fetchFile(artworkUrl)
    ]);

    await ffmpeg.writeFile('audio.mp3', audioData);
    await ffmpeg.writeFile('artwork.png', artworkData);
    await ffmpeg.writeFile('subs.ass', createAssSubtitle(dialogue, audioDuration));

    // 3. Run FFmpeg command
    await ffmpeg.exec([
      '-i', 'artwork.png', '-i', 'audio.mp3',
      '-vf', `scale=720:1280:force_original_aspect_ratio=decrease,boxblur=30:5,setsar=1,subtitles=subs.ass:force_style='Fontsize=48,Alignment=8,MarginV=100'`,
      '-c:v', 'libx264', '-tune', 'stillimage', '-c:a', 'aac', '-b:a', '192k', '-pix_fmt', 'yuv420p', '-shortest', '-movflags', '+faststart',
      'output.mp4'
    ]);

    // 4. Upload result to storage
    const videoData = await ffmpeg.readFile('output.mp4');
    const filePath = `${userId}/clips/${Date.now()}-viral-clip.mp4`;
    
    const { error: uploadError } = await supabaseAdmin.storage
      .from('viral-clips') // Ensure this bucket exists and is public
      .upload(filePath, videoData, { contentType: 'video/mp4' });

    if (uploadError) throw uploadError;

    const { data: { publicUrl } } = supabaseAdmin.storage.from('viral-clips').getPublicUrl(filePath);

    // 5. Update job status to 'complete' with the final URL
    await supabaseAdmin.from('video_jobs').update({ status: 'complete', video_url: publicUrl }).eq('id', job.id);

    await ffmpeg.terminate();
    
    return response.status(200).json({ success: true, videoUrl: publicUrl });

  } catch (error) {
    console.error('Video processing error:', error);
    // 6. Update job status to 'failed' on error
    await supabaseAdmin.from('video_jobs').update({ status: 'failed', error_message: error.message }).eq('id', job.id);
    return response.status(500).json({ error: error.message });
  }
}