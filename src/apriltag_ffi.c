#include <apriltag.h>
#include <tag36h11.h>
#include <common/zarray.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>

#define APRILTAG_CLASS_ID_OFFSET 1000

/* This helper intentionally owns its detector and reads one grayscale frame at a time. */
int main(void) {
  apriltag_family_t *family = tag36h11_create();
  apriltag_detector_t *detector = apriltag_detector_create();
  if (!family || !detector) return 2;
  apriltag_detector_add_family_bits(detector, family, 2);
  detector->quad_decimate = 2.0;
  detector->nthreads = 1;
  detector->refine_edges = 1;
  for (;;) {
    uint32_t header[3];
    if (fread(header, sizeof(header), 1, stdin) != 1) break;
    uint32_t seq = header[0], width = header[1], height = header[2];
    if (!width || !height || width > 4096 || height > 4096) return 3;
    size_t size = (size_t)width * height;
    uint8_t *pixels = malloc(size);
    if (!pixels) return 4;
    if (fread(pixels, 1, size, stdin) != size) { free(pixels); break; }
    image_u8_t image = { .width = (int)width, .height = (int)height, .stride = (int)width, .buf = pixels };
    zarray_t *found = apriltag_detector_detect(detector, &image);
    printf("{\"sequence\":%u,\"boxes\":[", seq);
    for (int i = 0; i < zarray_size(found); i++) {
      apriltag_detection_t *tag;
      zarray_get(found, i, &tag);
      double x0 = tag->p[0][0], x1 = x0, y0 = tag->p[0][1], y1 = y0;
      for (int j = 1; j < 4; j++) {
        if (tag->p[j][0] < x0) x0 = tag->p[j][0];
        if (tag->p[j][0] > x1) x1 = tag->p[j][0];
        if (tag->p[j][1] < y0) y0 = tag->p[j][1];
        if (tag->p[j][1] > y1) y1 = tag->p[j][1];
      }
      printf("%s{\"label\":\"tag36h11:%d\",\"classId\":%d,\"confidence\":1,\"x\":%.3f,\"y\":%.3f,\"width\":%.3f,\"height\":%.3f}", i ? "," : "", tag->id, APRILTAG_CLASS_ID_OFFSET + tag->id, x0, y0, x1-x0, y1-y0);
    }
    puts("]}"); fflush(stdout);
    apriltag_detections_destroy(found);
    free(pixels);
  }
  apriltag_detector_destroy(detector);
  tag36h11_destroy(family);
  return 0;
}
