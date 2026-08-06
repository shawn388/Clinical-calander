from flask import Flask, request, jsonify
import pdfplumber
import io

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
        for page_num, page in enumerate(pdf.pages):
            # Extract explicit visual table grid
            tables = page.extract_tables()
            
            for table in tables:
                for row in table:
                    # Clean empty cell values
                    cleaned_row = [cell.strip().replace('\n', ' ') if cell else "" for cell in row]
                    if any(cleaned_row):
                        results.append(cleaned_row)

    return jsonify({"page_count": len(pdf.pages), "grid_rows": results})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)