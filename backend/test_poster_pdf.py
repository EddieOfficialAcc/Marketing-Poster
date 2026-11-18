import io
import shutil
import subprocess
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import app
from backend.poster_pdf import process_pdf, command
from backend.test_support import IsolatedAuthTest, authenticated_client


def sample_pdf():
    stream = io.BytesIO()
    Image.new('RGB', (200, 300), 'red').save(stream, 'PDF', save_all=True,
        append_images=[Image.new('RGB', (300, 200), 'blue')])
    return stream.getvalue()


class PosterPdfTests(IsolatedAuthTest):
    def test_metadata_and_selected_page_render_with_real_poppler(self):
        if not shutil.which('pdftoppm') or not shutil.which('pdfinfo'):
            self.skipTest('Poppler not installed')
        data = sample_pdf()
        self.assertEqual(process_pdf(data), {'pages': 2})
        output, mime = process_pdf(data, 2)
        self.assertEqual(mime, 'image/png')
        with Image.open(io.BytesIO(output)) as image:
            self.assertEqual(image.width, 4000)
            self.assertGreater(image.width, image.height)
            red, green, blue = image.convert('RGB').getpixel((100, 100))
            self.assertGreater(blue, 240)
            self.assertLess(red, 10)
        with self.assertRaises(HTTPException) as error:
            process_pdf(data, 3)
        self.assertEqual(error.exception.status_code, 422)

    def test_reject_invalid_and_large_input(self):
        for data in (b'', b'not pdf'):
            with self.assertRaises(HTTPException):
                process_pdf(data)
        with patch('backend.poster_pdf.MAX_BYTES', 3):
            with self.assertRaises(HTTPException) as error:
                process_pdf(b'%PDF-')
            self.assertEqual(error.exception.status_code, 413)

    def test_encrypted_and_invalid_page_count(self):
        for info in (b'Pages: 2\nEncrypted: yes\n', b'Pages: 201\n', b'Pages: 0\n'):
            with patch('backend.poster_pdf.command', return_value=info):
                with self.assertRaises(HTTPException):
                    process_pdf(b'%PDF-1.4')

    def test_timeout_and_missing_converter_are_actionable(self):
        for problem, code in [(FileNotFoundError(), 503), (subprocess.TimeoutExpired('pdfinfo', 30), 422)]:
            with patch('backend.poster_pdf.subprocess.run', side_effect=problem):
                with self.assertRaises(HTTPException) as error:
                    command(['pdfinfo', 'source.pdf'])
                self.assertEqual(error.exception.status_code, code)

    def test_api_requires_login_and_returns_selected_page(self):
        self.assertEqual(TestClient(app).post('/api/poster-pdf/info', content=b'%PDF').status_code, 401)
        client = authenticated_client(app)
        with patch('backend.poster_pdf.process_pdf', return_value={'pages': 2}) as process:
            response = client.post('/api/poster-pdf/info', content=b'%PDF')
            self.assertEqual(response.json(), {'pages': 2})
            process.assert_called_once_with(b'%PDF')
        with patch('backend.poster_pdf.process_pdf', return_value=(b'png', 'image/png')) as process:
            response = client.post('/api/poster-pdf/render?page=2', content=b'%PDF')
            self.assertEqual(response.content, b'png')
            self.assertEqual(response.headers['cache-control'], 'no-store')
            process.assert_called_once_with(b'%PDF', 2)
        with patch('backend.poster_pdf.MAX_BYTES', 3):
            self.assertEqual(client.post('/api/poster-pdf/info', content=b'%PDF').status_code, 413)
