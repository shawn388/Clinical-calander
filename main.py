from flask import Flask, request, jsonify
import pdfplumber
import io

app = Flask(__name__)

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "service": "Anchored Spatial Engine"})

@app.route('/parse-calendar', methods=['POST'])
def parse_calendar():
    if 'file' not in request.files:
        return jsonify({"error": "No PDF file provided"}), 400
    
    pdf_bytes = request.files['file'].read()
    results = []
    
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            words = page.extract_words()
            if not words:
                continue
                
            # 1. Group words by horizontal rows (Y-axis)
            rows_dict = {}
            for w in words:
                y = round(w['top'] / 5) * 5
                if y not in rows_dict:
                    rows_dict[y] = []
                rows_dict[y].append(w)
                
            # 2. Dynamically calculate column widths based on the printed headers
            sunday_x0 = None
            saturday_x0 = None
            
            for w in words:
                text = w['text'].lower().strip()
                if 'sunday' in text and w['top'] < 200:
                    sunday_x0 = w['x0']
                if 'saturday' in text and w['top'] < 200:
                    saturday_x0 = w['x0']
                    
            if sunday_x0 is not None and saturday_x0 is not None:
                # The distance between Sunday and Saturday is exactly 6 columns
                col_width = (saturday_x0 - sunday_x0) / 6
                # Create 7 boundary markers
                col_bounds = [sunday_x0 + (i * col_width) for i in range(8)]
            else:
                # Fallback if headers are somehow missing
                col_width = page.width / 7
                col_bounds = [i * col_width for i in range(8)]
                
            # 3. Lock words into the 7 columns based on exact X-coordinates
            for y in sorted(rows_dict.keys()):
                row_words = sorted(rows_dict[y], key=lambda w: w['x0'])
                cols = ["" for _ in range(7)]
                
                for w in row_words:
                    x = w['x0']
                    col_index = 6 # Default to last column
                    
                    for i in range(6):
                        # 5 pixel buffer to catch letters slightly over the line
                        if x < (col_bounds[i+1] - 5):
                            col_index = i
                            break
                            
                    cols[col_index] += (" " if cols[col_index] else "") + w['text']
                    
                if any(cols):
                    results.append(cols)
                    
    return jsonify({"page_count": len(pdf.pages), "grid_rows": results})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
