import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * Directory structure
 */
const ROOT_DIR = process.cwd();
const TMP_DIR = path.join(ROOT_DIR, "tmp");
const CLIPS_DIR = path.join(TMP_DIR, "clips");
const OUTPUT_DIR = path.join(TMP_DIR, "output");
const PERMANENT_DIR = path.join(ROOT_DIR, "merged_videos");

// Ensure directories exist
[CLIPS_DIR, OUTPUT_DIR, PERMANENT_DIR].forEach(dir => {
  fs.mkdirSync(dir, { recursive: true });
});

/**
 * POST /merge
 * Body: { clips: string[] }
 */
app.post("/merge", async (req, res) => {
  const { clips } = req.body;

  if (!Array.isArray(clips)) {
    return res.status(400).json({ error: "clips must be an array" });
  }

  if (clips.length < 2 || clips.length > 10) {
    return res.status(400).json({ error: "clips must contain 2 to 10 video URLs" });
  }

  const sessionId = uuidv4();
  const sessionClipDir = path.join(CLIPS_DIR, sessionId);
  const sessionOutputDir = path.join(OUTPUT_DIR, sessionId);

  fs.mkdirSync(sessionClipDir, { recursive: true });
  fs.mkdirSync(sessionOutputDir, { recursive: true });

  try {
    console.log(`[MERGE] Session ${sessionId} started with ${clips.length} clips`);

    /**
     * 1️⃣ Download clips
     */
    const clipPaths = [];

    for (let i = 0; i < clips.length; i++) {
      const clipUrl = clips[i];
      const clipPath = path.join(sessionClipDir, `clip_${i}.mp4`);

      console.log(`[MERGE] Downloading clip ${i + 1}`);

      const response = await axios.get(clipUrl, { responseType: "stream" });
      const writer = fs.createWriteStream(clipPath);

      await new Promise((resolve, reject) => {
        response.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      clipPaths.push(clipPath);
    }

    /**
     * 2️⃣ Create concat.txt
     */
    const concatFilePath = path.join(sessionClipDir, "concat.txt");
    const concatFileContent = clipPaths
      .map(p => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");

    fs.writeFileSync(concatFilePath, concatFileContent);

    /**
     * 3️⃣ Run FFmpeg merge (RE-ENCODED for correctness)
     */
    const tempOutputPath = path.join(sessionOutputDir, "merged.mp4");

    const ffmpegCommand =
      `ffmpeg -y -f concat -safe 0 -i "${concatFilePath}" ` +
      `-c:v libx264 -preset fast -crf 18 ` +
      `-c:a aac -b:a 192k ` +
      `-movflags +faststart "${tempOutputPath}"`;

    console.log("[MERGE] Running FFmpeg...");
    console.log(ffmpegCommand);

    exec(ffmpegCommand, (error) => {
      if (error) {
        console.error("[MERGE] FFmpeg failed:", error);
        return res.status(500).json({ error: "Video merge failed" });
      }

      if (!fs.existsSync(tempOutputPath)) {
        console.error("[MERGE] Output file not found");
        return res.status(500).json({ error: "FFmpeg did not produce output file" });
      }

      /**
       * 4️⃣ Save merged video permanently (debug)
       */
      const finalOutputPath = path.join(
        PERMANENT_DIR,
        `merged-${sessionId}.mp4`
      );

      fs.copyFileSync(tempOutputPath, finalOutputPath);
      console.log("[MERGE] Saved merged video:", finalOutputPath);

      /**
       * 5️⃣ Stream merged video back to client
       */
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", "inline; filename=merged.mp4");

      const readStream = fs.createReadStream(tempOutputPath);
      readStream.pipe(res);

      /**
       * 6️⃣ Cleanup temp files after response
       */
      res.on("finish", () => {
        fs.rmSync(sessionClipDir, { recursive: true, force: true });
        fs.rmSync(sessionOutputDir, { recursive: true, force: true });
        console.log("[MERGE] Cleaned temp files for", sessionId);
      });
    });

  } catch (err) {
    console.error("[MERGE] Unexpected error:", err);
    fs.rmSync(sessionClipDir, { recursive: true, force: true });
    fs.rmSync(sessionOutputDir, { recursive: true, force: true });
    res.status(500).json({ error: "Unexpected server error" });
  }
});

/**
 * Server start
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Video merge service running on port ${PORT}`);
});
