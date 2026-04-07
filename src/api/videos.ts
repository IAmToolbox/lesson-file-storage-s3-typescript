import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

import path from "node:path";
const { randomBytes } = await import("node:crypto");

const MAX_UPLOAD_SIZE = 1 << 30;

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log(`Uploading new video ${videoId} by user ${userID}`);

  const videoMetadata = getVideo(cfg.db, videoId);
  if (!(videoMetadata.userID === userID)) {
    throw new UserForbiddenError("Wrong user");
  }

  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File) || file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video file missing/too big");
  }

  const fileType = file.type;
  const buffer = randomBytes(32);
  const keyName = buffer.toString("base64url");
  if (fileType === "video/mp4") {
    const extension = fileType.slice(6);
    const filePath = path.join(cfg.assetsRoot, `temp.${extension}`)
    await Bun.write(filePath, file);
    const ratio = await getVideoAspectRatio(filePath);
    const processedFilePath = await processVideoForFastStart(filePath);

    const s3File = cfg.s3Client.file(`${ratio}/${keyName}.${extension}`, { bucket: cfg.s3Bucket });
    const videoFile = Bun.file(processedFilePath);
    await s3File.write(videoFile, { type: fileType });

    const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${ratio}/${keyName}.${extension}`;
    videoMetadata.videoURL = videoURL;
    updateVideo(cfg.db, videoMetadata);

    await Bun.file(filePath).delete();
    await Bun.file(processedFilePath).delete();
    return respondWithJSON(200, videoMetadata);
  } else {
    throw new BadRequestError("Unsupported file type");
  }
}

async function getVideoAspectRatio(filePath: string) {
  const ffprobeProc = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", filePath], {
    stderr: "pipe",
  });
  const exitCode = await ffprobeProc.exited;
  const stdoutText = await new Response(ffprobeProc.stdout).text();
  const stderrText = await new Response(ffprobeProc.stderr).text();
  if (exitCode !== 0) {
    console.error(stderrText);
    throw new Error("Couldn't parse aspect ratio");
  }
  const stdoutParsed = JSON.parse(stdoutText);
  const width = stdoutParsed.streams[0].width;
  const height = stdoutParsed.streams[0].height;

  // Time to parse out the aspect ratio

  if (Math.floor(16 * (height / 9)) === width) {
    return "landscape";
  } else if (Math.floor(16 * (width / 9)) === height) {
    return "portrait";
  } else {
    return "other";
  }
}

async function processVideoForFastStart(filePath) {
  const outFilePath = `${filePath}.processed`;
  const ffmpegProc = Bun.spawn(["ffmpeg", "-i", filePath, "-movflags", "faststart", "-map_metadata", "0", "-codec", "copy", "-f", "mp4", outFilePath], {
    stderr: "pipe",
  });
  const exitCode = await ffmpegProc.exited;
  if (exitCode === 0) {
    return outFilePath;
  } else {
    console.log(await new Response(ffmpegProc.stderr).text());
    throw new Error("Unable to process video");
  }
}
