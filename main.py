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
    
    # NEW: Highly aggressive table settings to force a 7-column grid without relying on physical lines
    custom_table_settings = {
        "vertical_strategy": "text",
        "horizontal_strategy": "text",
        "snap_tolerance": 5,
        "join_tolerance": 5
    }

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page_num, page in enumerate(pdf.pages):
            # Extract tables using the new text-alignment strategy
            tables = page.extract_tables(table_settings=custom_table_settings)
            
            for table in tables:
                for row in table:
                    # Clean empty cell values
                    cleaned_row = [cell.strip().replace('\n', ' ') if cell else "" for cell in row]
                    if any(cleaned_row):
                        results.append(cleaned_row)
                        
    return jsonify({"page_count": len(pdf.pages), "grid_rows": results})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
