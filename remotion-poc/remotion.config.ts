import { Config } from "@remotion/cli/config";

// Match the production ffmpeg output exactly: H.264, yuv420p, CRF 20.
Config.setVideoImageFormat("jpeg");
Config.setCodec("h264");
Config.setCrf(20);
Config.overrideWebpackConfig((c) => c);
