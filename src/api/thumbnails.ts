import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

import path from "node:path";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const videoThumbnails: Map<string, Thumbnail> = new Map();
const MAX_UPLOAD_SIZE = 10 << 20;

export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = videoThumbnails.get(videoId);
  if (!thumbnail) {
    throw new NotFoundError("Thumbnail not found");
  }

  return new Response(thumbnail.data, {
    headers: {
      "Content-Type": thumbnail.mediaType,
      "Cache-Control": "no-store",
    },
  });
}

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();

  const file = formData.get("thumbnail");
  if (!(file instanceof File) || file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail file missing/too big");
  }
  const fileType = file.type;

  const buffer = Buffer.from(await file.arrayBuffer());
  if (fileType.includes("image")) {
    const extension = fileType.slice(6);
    const filePath = path.join(cfg.assetsRoot, `${videoId}.${extension}`);
    await Bun.write(filePath, file);
    //const dataURL = `data:${fileType};base64,${encodedThumbnail}`;
    const videoMetadata = getVideo(cfg.db, videoId);
    if (!(videoMetadata.userID === userID)) {
      throw new UserForbiddenError("Wrong user");
    }
    //videoThumbnails.set(videoId, { data: buffer, mediaType: fileType });
    const thumbnailURL = `http://localhost:${cfg.port}/assets/${videoId}.${extension}`;
    videoMetadata.thumbnailURL = thumbnailURL;
    updateVideo(cfg.db, videoMetadata);

    return respondWithJSON(200, videoMetadata);
  } else {
    throw new BadRequestError("Unsupported file type");
  }
}
