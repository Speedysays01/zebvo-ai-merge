import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(express.json({ limit: "1mb" }));

const TMP_DIR = path.resolve("tmp");
const CLIPS_DIR = path.join(TMP_DIR, "clips");
const OUTPUT_DIR = path.join(TMP_DIR, "output");

// Ensure temp directories exist
fs.mkdirSync(CLIPS_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

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
    // 1️⃣ Download all clips
    const clipPaths = [];

    for (let i = 0; i < clips.length; i++) {
      const clipUrl = clips[i];
      const clipPath = path.join(sessionClipDir, `clip_${i}.mp4`);

      const response = await axios.get(clipUrl, { responseType: "stream" });
      const writer = fs.createWriteStream(clipPath);

      await new Promise((resolve, reject) => {
        response.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      clipPaths.push(clipPath);
    }

    // 2️⃣ Create FFmpeg concat file
    const concatFilePath = path.join(sessionClipDir, "concat.txt");
    const concatFileContent = clipPaths
      .map(p => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");

    fs.writeFileSync(concatFilePath, concatFileContent);

    // 3️⃣ Run FFmpeg merge
    const outputFilePath = path.join(sessionOutputDir, "merged.mp4");

    const ffmpegCommand = `ffmpeg -y -f concat -safe 0 -i "${concatFilePath}" -c copy "${outputFilePath}"`;

    exec(ffmpegCommand, (error) => {
      if (error) {
        console.error("FFmpeg error:", error);
        return res.status(500).json({ error: "Video merge failed" });
      }

      // 4️⃣ Stream video back to client
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", "inline; filename=merged.mp4");

      const readStream = fs.createReadStream(outputFilePath);
      readStream.pipe(res);

      // 5️⃣ Cleanup after response finishes
      res.on("finish", () => {
        fs.rmSync(sessionClipDir, { recursive: true, force: true });
        fs.rmSync(sessionOutputDir, { recursive: true, force: true });
      });
    });

  } catch (err) {
    console.error("Merge error:", err);
    fs.rmSync(sessionClipDir, { recursive: true, force: true });
    fs.rmSync(sessionOutputDir, { recursive: true, force: true });
    res.status(500).json({ error: "Unexpected server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Video merge service running on port ${PORT}`);
});
