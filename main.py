\from flask import Flask, request, jsonify
import pdfplumber
import io
import re

app = Flask(__name__)

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "service": "Platinum Planner pdfplumber Engine"})

@app.route('/parse-calendar', methods=['POST'])
def parse_calendar():
    if 'file' not in request.files:
        return jsonify({"error": "No PDF file provided"}), 400
    
    pdf_file = request.files['file']
    pdf_bytes = pdf_file.read()
    results = []
    
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            # Read the page visually exactly as a human sees it
            text = page.extract_text(layout=True)
            if text:
                for line in text.split('\n'):
                    # Split into columns wherever there are 2 or more consecutive spaces
                    cols = [col.strip() for col in re.split(r' {2,}', line) if col.strip()]
                    if cols:
                        results.append(cols)
                        
    return jsonify({"page_count": len(pdf.pages), "grid_rows": results})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
