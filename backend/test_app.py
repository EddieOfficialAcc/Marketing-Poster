from backend.test_support import authenticated_client, IsolatedAuthTest
"""API/validation tests; these do not claim to test real model inference."""
import io
import unittest
from unittest.mock import patch
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from backend.app import app, decode_image, encode_result


def png(mode="RGBA", color=(255, 0, 0, 255)):
    image = Image.new(mode, (12, 12), color)
    if mode == "RGBA":
        image.putpixel((0, 0), (0, 0, 0, 0))
    output = io.BytesIO()
    image.save(output, "PNG")
    return output.getvalue()


class CutoutTests(IsolatedAuthTest):
    def test_decoder_rejects_empty_or_corrupt_images(self):
        for data in (b"", b"not an image"):
            with self.assertRaises(HTTPException):
                decode_image(data)

    def test_valid_png_preserves_original_pixels(self):
        image = decode_image(png())
        self.assertEqual(image.size, (12, 12))
        self.assertEqual(image.getpixel((1, 1)), (255, 0, 0, 255))

    def test_result_must_have_both_foreground_and_transparency(self):
        for alpha in (0, 255):
            with self.assertRaises(HTTPException):
                encode_result(Image.new("RGBA", (10, 10), (0, 0, 0, alpha)))
        self.assertTrue(encode_result(decode_image(png())).startswith(b"\x89PNG"))

    def test_cutout_preserves_canvas_scale_and_faint_packaging(self):
        original = Image.new("RGBA", (100, 120))
        original.paste((240, 20, 10, 255), (30, 50, 60, 100))
        original.putpixel((29, 49), (200, 200, 200, 1))
        result = Image.open(io.BytesIO(encode_result(original)))
        self.assertEqual(result.width, original.width)
        self.assertEqual(result.height, original.height)
        self.assertEqual(result.getpixel((29, 49)), (200, 200, 200, 1))
        self.assertEqual(result.getpixel((30, 50)), (240, 20, 10, 255))

    def test_endpoint_rejects_non_image_content_type(self):
        response = authenticated_client(app).post("/api/remove-background", content=b"text")
        self.assertEqual(response.status_code, 415)

    def test_endpoint_returns_png_from_processing_service(self):
        with patch("backend.app.process_image", return_value=png()) as process:
            response = authenticated_client(app).post("/api/remove-background", content=png(), headers={"Content-Type": "image/png"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], "image/png")
            self.assertEqual(response.content, png())
            process.assert_called_once()


if __name__ == "__main__":
    unittest.main()
