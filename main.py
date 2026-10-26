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
        for page in pdf.pages:
            width = page.width
            # Mathematically slice the page into 7 equal columns based on page width
            col_width = width / 7
            
            # Extract words with their exact bounding boxes
            words = page.extract_words()
            
            # Group words by their vertical Y-coordinate (rounding to nearest 5 pixels to group rows)
            rows_dict = {}
            for w in words:
                y = round(w['top'] / 5) * 5
                if y not in rows_dict:
                    rows_dict[y] = []
                rows_dict[y].append(w)
                
            # Sort the rows from top to bottom
            for y in sorted(rows_dict.keys()):
                row_words = rows_dict[y]
                cols = ["" for _ in range(7)]
                
                for w in row_words:
                    # Calculate which of the 7 columns this word falls into based on its X-coordinate
                    col_index = min(int(w['x0'] // col_width), 6)
                    cols[col_index] += (" " if cols[col_index] else "") + w['text']
                
                # Only add rows that actually have text
                if any(cols):
                    results.append(cols)
                        
    return jsonify({"page_count": len(pdf.pages), "grid_rows": results})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
