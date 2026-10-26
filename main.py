"""HTTP adapter; deployment requires PARSER_API_TOKEN."""
import hmac
import os
from flask import Flask, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge
from calendar_parser import PARSER_VERSION, ParseFailure, parse_pdf

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 8 * 1024 * 1024

@app.get('/health')
def health():
    return jsonify(status='ok', service='Clinical Calendar Parser', parser_version=PARSER_VERSION,
                   commit=os.getenv('RENDER_GIT_COMMIT', 'local'))

@app.errorhandler(RequestEntityTooLarge)
def too_large(_error):
    return jsonify(schema_version=2, status='failed', errors=[{'category': 'FILE_TOO_LARGE',
                   'reason': 'Upload exceeds 8 MiB'}], shifts=[], coverage_complete=False), 413

@app.post('/parse-calendar')
def parse_calendar():
    token = app.config.get('PARSER_API_TOKEN', os.getenv('PARSER_API_TOKEN', ''))
    allow_public = app.config.get('ALLOW_UNAUTHENTICATED', os.getenv('ALLOW_UNAUTHENTICATED') == 'true')
    if not token and not allow_public:
        return jsonify(error='Parser authentication is not configured'), 503
    if token and not hmac.compare_digest(request.headers.get('Authorization', ''), 'Bearer ' + token):
        return jsonify(error='Unauthorized'), 401
    if 'file' not in request.files:
        return jsonify(schema_version=2, status='failed', errors=[{'category': 'MISSING_FILE',
                       'reason': 'Provide a PDF in multipart field file'}], shifts=[], coverage_complete=False), 400
    try:
        upload = request.files['file']
        result = parse_pdf(upload.read(), upload.filename or '')
        return jsonify(result), 200 if result['coverage_complete'] else 422
    except ParseFailure as error:
        return jsonify(schema_version=2, status='failed', errors=[error.as_dict()],
                       shifts=[], unresolved_blocks=[], coverage_complete=False), 422
    except Exception:
        app.logger.exception('Unexpected calendar parsing failure')
        return jsonify(schema_version=2, status='failed', errors=[{'category': 'INTERNAL_ERROR',
                       'reason': 'Parser failed; inspect server logs'}], shifts=[], coverage_complete=False), 500

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=int(os.getenv('PORT', '5000')))
