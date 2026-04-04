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

    const s3File = cfg.s3Client.file(`${keyName}.${extension}`, { bucket: cfg.s3Bucket });
    const videoFile = Bun.file(filePath);
    await s3File.write(videoFile, { type: fileType });

    const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${keyName}.${extension}`;
    videoMetadata.videoURL = videoURL;
    updateVideo(cfg.db, videoMetadata);

    await Bun.file(filePath).delete();
    return respondWithJSON(200, videoMetadata);
  } else {
    throw new BadRequestError("Unsupported file type");
  }
}

async function getVideoAspectRatio(filePath: string) {
  const ffprobeProc = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", filePath], {
    stderr: "pipe",
  });
  const stdoutText = await new Response(ffprobeProc.stdout).text();
  const stderrText = await new Response(ffprobeProc.stderr).text();
  if (ffprobeProc.exited !== 0) {
    console.err(stderrText);
    throw new Error("Couldn't parse aspect ratio");
  }
}
