from flask import Flask, request, jsonify
import pdfplumber
import io

app = Flask(__name__)

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "service": "Visual Slicing Engine"})

@app.route('/parse-calendar', methods=['POST'])
def parse_calendar():
    if 'file' not in request.files:
        return jsonify({"error": "No PDF file provided"}), 400
    
    pdf_bytes = request.files['file'].read()
    results = []
    
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            # layout=True forces the text to maintain exact physical spaces
            text = page.extract_text(layout=True)
            if not text:
                continue
            
            lines = text.split('\n')
            
            # 1. Find the column character indices dynamically from the header row
            indices = [0, 15, 30, 45, 60, 75, 90, 9999] # Fallback spacing
            
            for line in lines:
                if 'Sunday' in line and 'Monday' in line and 'Saturday' in line:
                    indices = [
                        0, # Sunday catches everything from the left edge
                        line.find('Monday'),
                        line.find('Tuesday'),
                        line.find('Wednesday'),
                        line.find('Thursday'),
                        line.find('Friday'),
                        line.find('Saturday'),
                        9999 # Saturday catches everything to the right edge
                    ]
                    break
                    
            # 2. Slice every line based on these exact character indices
            for line in lines:
                if not line.strip():
                    continue
                
                cols = []
                for i in range(7):
                    start = indices[i]
                    end = indices[i+1]
                    
                    # Slice the string at the exact column boundaries and strip spaces
                    col_text = line[start:end].strip() if start < len(line) else ""
                    cols.append(col_text)
                    
                # Only append if the row has data
                if any(cols):
                    results.append(cols)
                    
    return jsonify({"page_count": len(pdf.pages), "grid_rows": results})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
