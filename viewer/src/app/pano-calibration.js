export const wrapDegrees = value => ((value + 180) % 360 + 360) % 360 - 180;
export const wrapUnit = value => ((value % 1) + 1) % 1;
// Same equirectangular convention as pano360.js: u=.5+(imageYaw-worldYaw)/360.
export const imageYawForAnchor = (mapYaw, u) => wrapDegrees(mapYaw + 360 * wrapUnit(u) - 180);
export const panoramaUForHeading = (imageYaw, mapYaw) => wrapUnit(.5 + (imageYaw - mapYaw) / 360);
export const mapYawToward = (origin, target) => wrapDegrees(Math.atan2(-(target[0]-origin[0]), -(target[1]-origin[1])) * 180 / Math.PI);
