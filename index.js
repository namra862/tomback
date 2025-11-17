// File: index.js (Your Backend - FULL VERSION)
const express = require('express');
const multer = require('multer');
const { PDFDocument, rgb } = require('pdf-lib');
const cors = require('cors');
const puppeteer = require('puppeteer'); // For HTML to PDF
// --- FIX: Replaced pdf-poppler with pdf2pic ---
const { fromPath } = require("pdf2pic"); // For PDF to JPG
const archiver = require('archiver');   // For zipping files
const fs = require('fs-extra');       // For file system operations
const path = require('path');           // For handling file paths

const app = express();
const port = 5000;

// --- Middlewares ---
app.use(cors());
app.use(express.json()); // For /html-to-pdf to read the URL
app.use(express.urlencoded({ extended: true })); // For form data

// --- File Storage Setup ---
// We MUST save files to disk for tools like pdf-poppler to work
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/';
    fs.ensureDirSync(dir); // Ensure the upload directory exists
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // Use a unique name to prevent conflicts
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ storage: storage });

// --- Helper Function ---
// We need a way to clean up the uploaded/processed files
const cleanup = async (files) => {
  if (!Array.isArray(files)) files = [files]; // Ensure it's an array
  for (const file of files) {
    if (typeof file === 'string') {
      await fs.remove(file); // Remove a file or directory
    } else if (file && file.path) {
      await fs.remove(file.path); // Remove an uploaded file
    }
  }
};

// ===============================================
// === CATEGORY 1: PDF/IMAGE MANIPULATION ========
// ===============================================

// --- 1. Merge PDF ---
app.post('/merge', upload.array('files'), async (req, res) => {
  let filesToCleanup = [...req.files];
  let processedFilePath = '';
  try {
    const mergedPdf = await PDFDocument.create();
    for (const file of req.files) {
      const pdfBytes = await fs.readFile(file.path);
      const pdf = await PDFDocument.load(pdfBytes);
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      pages.forEach((page) => mergedPdf.addPage(page));
    }

    const mergedPdfBytes = await mergedPdf.save();
    
    // Save the final file to send it
    processedFilePath = `uploads/merged-${Date.now()}.pdf`;
    await fs.writeFile(processedFilePath, mergedPdfBytes);
    filesToCleanup.push(processedFilePath);

    res.download(processedFilePath, 'merged.pdf', async (err) => {
      await cleanup(filesToCleanup); // Clean up ALL files
    });

  } catch (err) {
    console.error(err);
    await cleanup(filesToCleanup);
    res.status(500).send('An error occurred while merging the PDFs.');
  }
});

// --- 2. JPG to PDF ---
app.post('/jpg-to-pdf', upload.array('files'), async (req, res) => {
  let filesToCleanup = [...req.files];
  let processedFilePath = '';
  try {
    const pdfDoc = await PDFDocument.create();
    for (const file of req.files) {
      const imgBytes = await fs.readFile(file.path);
      // Check if it's JPG (pdf-lib also supports png)
      let image;
      if (file.mimetype === 'image/jpeg') {
        image = await pdfDoc.embedJpg(imgBytes);
      } else if (file.mimetype === 'image/png') {
        image = await pdfDoc.embedPng(imgBytes);
      } else {
        throw new Error('Unsupported image type. Only JPG/PNG are supported.');
      }
      
      const page = pdfDoc.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    }

    const pdfBytes = await pdfDoc.save();
    processedFilePath = `uploads/images-${Date.now()}.pdf`;
    await fs.writeFile(processedFilePath, pdfBytes);
    filesToCleanup.push(processedFilePath);

    res.download(processedFilePath, 'images.pdf', async (err) => {
      await cleanup(filesToCleanup);
    });

  } catch (err) {
    console.error(err);
    await cleanup(filesToCleanup);
    res.status(500).send('Error converting images to PDF. Only JPG/PNG are supported.');
  }
});

// --- 3. Extract Pages ---
// Expects a single file and a page range string like "1-3,5,7"
app.post('/extract', upload.single('file'), async (req, res) => {
  let filesToCleanup = [req.file];
  let processedFilePath = '';
  try {
    const { range } = req.body; // e.g., "1-3, 5"
    if (!range) return res.status(400).send('No page range provided.');

    const pdfBytes = await fs.readFile(req.file.path);
    const pdf = await PDFDocument.load(pdfBytes);
    const extractedPdf = await PDFDocument.create();

    // Basic page range parser
    const indices = [];
    range.split(',').forEach(segment => {
      segment = segment.trim();
      if (segment.includes('-')) {
        const [start, end] = segment.split('-').map(Number);
        for (let i = start; i <= end; i++) {
          if(i > 0 && i <= pdf.getPageCount()) indices.push(i - 1); // 0-indexed
        }
      } else {
        const pageNum = Number(segment);
        if(pageNum > 0 && pageNum <= pdf.getPageCount()) indices.push(pageNum - 1); // 0-indexed
      }
    });
    
    const uniqueIndices = [...new Set(indices)]; // Remove duplicates

    const pages = await extractedPdf.copyPages(pdf, uniqueIndices);
    pages.forEach((page) => extractedPdf.addPage(page));

    const extractedPdfBytes = await extractedPdf.save(); // <-- FIX from previous bug
    processedFilePath = `uploads/extracted-${Date.now()}.pdf`;
    await fs.writeFile(processedFilePath, extractedPdfBytes); // <-- Use the new name here too
    filesToCleanup.push(processedFilePath);

    res.download(processedFilePath, 'extracted.pdf', async (err) => {
      await cleanup(filesToCleanup);
    });

  } catch (err) {
    console.error(err);
    await cleanup(filesToCleanup);
    res.status(500).send('Error extracting pages. Check your page range.');
  }
});

// --- 4. Split PDF ---
// This will split the PDF into individual pages and send them as a .zip
app.post('/split', upload.single('file'), async (req, res) => {
  let filesToCleanup = [req.file];
  const outputDir = `uploads/split-${Date.now()}`;
  const zipPath = `${outputDir}.zip`;
  
  try {
    await fs.ensureDir(outputDir); // Create a temp folder for split pages
    filesToCleanup.push(outputDir);
    filesToCleanup.push(zipPath);

    const pdfBytes = await fs.readFile(req.file.path);
    const pdf = await PDFDocument.load(pdfBytes);
    
    for (let i = 0; i < pdf.getPageCount(); i++) {
      const newPdf = await PDFDocument.create();
      const [page] = await newPdf.copyPages(pdf, [i]);
      newPdf.addPage(page);
      const newPdfBytes = await newPdf.save();
      await fs.writeFile(path.join(outputDir, `page_${i + 1}.pdf`), newPdfBytes);
    }

    // Create a zip file
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    output.on('close', () => {
      res.download(zipPath, 'split.zip', async (err) => {
        await cleanup(filesToCleanup); // Clean up original file, temp dir, and zip
      });
    });

    archive.pipe(output);
    archive.directory(outputDir, false); // Add the directory of PDFs to the zip
    await archive.finalize();

  } catch (err) {
    console.error(err);
    await cleanup(filesToCleanup);
    res.status(500).send('Error splitting PDF.');
  }
});

// --- 5. Organize PDF ---
// Expects a file and a new page order, e.g., "3,1,2"
app.post('/organize', upload.single('file'), async (req, res) => {
  let filesToCleanup = [req.file];
  let processedFilePath = '';
  try {
    const { order } = req.body; // e.g., "3,1,2"
    if (!order) return res.status(400).send('No page order provided.');

    const pdfBytes = await fs.readFile(req.file.path);
    const pdf = await PDFDocument.load(pdfBytes);
    const organizedPdf = await PDFDocument.create();

    // 1-indexed order string
    const indices = order.split(',').map(n => Number(n.trim()) - 1);
    
    // Validate indices
    const maxPage = pdf.getPageCount();
    const validIndices = indices.filter(i => i >= 0 && i < maxPage);

    const pages = await organizedPdf.copyPages(pdf, validIndices);
    pages.forEach((page) => organizedPdf.addPage(page));

    const organizedPdfBytes = await organizedPdf.save(); // <-- FIX from previous bug
    processedFilePath = `uploads/organized-${Date.now()}.pdf`;
    await fs.writeFile(processedFilePath, organizedPdfBytes); // <-- Use the new name here too
    filesToCleanup.push(processedFilePath);

    res.download(processedFilePath, 'organized.pdf', async (err) => {
      await cleanup(filesToCleanup);
    });

  } catch (err)
 {
    console.error(err);
    await cleanup(filesToCleanup);
    res.status(500).send('Error organizing PDF. Check your page order.');
  }
});


// ===============================================
// === CATEGORY 2: CONVERSION (REQUIRES TOOLS) ===
// ===============================================

// --- 6. HTML to PDF ---
app.post('/html-to-pdf', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).send('No URL provided.');
  
  let browser;
  let filesToCleanup = [];
  try {
    browser = await puppeteer.launch({ 
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ] 
    }); // --no-sandbox is often needed in server environments
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0' });
    
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();

    const processedFilePath = `uploads/website-${Date.now()}.pdf`;
    await fs.writeFile(processedFilePath, pdfBuffer);
    filesToCleanup.push(processedFilePath);

    res.download(processedFilePath, 'website.pdf', async (err) => {
      await cleanup(filesToCleanup);
    });

  } catch (err) {
    console.error(err);
    if (browser) await browser.close();
    await cleanup(filesToCleanup);
    res.status(500).send('Error converting HTML to PDF.');
  }
});

// --- 7. PDF to JPG ---
// --- FIX: This function is rewritten to use pdf2pic ---
app.post('/pdf-to-jpg', upload.single('file'), async (req, res) => {
  let filesToCleanup = [req.file];
  const outputDir = `uploads/jpgs-${Date.now()}`;
  const zipPath = `${outputDir}.zip`;

  try {
    await fs.ensureDir(outputDir);
    filesToCleanup.push(outputDir);
    filesToCleanup.push(zipPath);

    // 1. Configure pdf2pic
    const options = {
      density: 100,
      saveDir: outputDir,
      saveFilename: "page",
      format: "jpg",
      width: 800,
      height: 1000
    };
    
    // 2. This creates a function to convert all pages
    const convert = fromPath(req.file.path, options);
    
    // 3. Call the function to convert all pages (bulk conversion)
    await convert.bulk(-1, true); // -1 means all pages

    // 4. Zip the resulting images
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    output.on('close', () => {
      res.download(zipPath, 'images.zip', async (err) => {
        await cleanup(filesToCleanup);
      });
    });

    archive.pipe(output);
    archive.directory(outputDir, false);
    await archive.finalize();

  } catch (err) {
    console.error(err);
    await cleanup(filesToCleanup);
    res.status(500).send('Error converting PDF to JPG. Is "poppler" (pdf2pic dependency) installed on the server?');
  }
});


// ===============================================
// === CATEGORY 3: THE "HARD" FUNCTIONS ========
// ===============================================

// --- 8. Word to PDF / Excel to PDF / PPT to PDF ---
app.post('/office-to-pdf', upload.single('file'), async (req, res) => {
  //
  // This is EXTREMELY complex.
  // OPTION 1: Use a Paid API (e.g., Adobe, CloudConvert, Aspose).
  //   - You would send req.file.path to their API and get a PDF back.
  //
  // OPTION 2: Install LibreOffice on your server.
  //   - Use Node.js 'exec' function to run a command like:
  //   - `libreoffice --headless --convert-to pdf ${req.file.path} --outdir uploads/`
  //   - This is heavy, slow, and hard to set up.
  //
  res.status(501).send('Not Implemented: Office-to-PDF conversion requires a paid API or server-side software like LibreOffice.');
  await cleanup([req.file]); // Still clean up the upload
});


// --- 9. PDF to Word / PDF to Excel / PDF to PPT ---
app.post('/pdf-to-office', upload.single('file'), async (req, res) => {
  //
  // This is even HARDER than Office-to-PDF.
  // This almost *always* requires a specialized, paid API.
  // Free tools cannot reliably reconstruct an editable .docx file.
  //
  // Your code here would call an external API:
  //   const result = await AdobeApi.pdfToWord(req.file.path);
  //   res.download(result.path);
  //
  res.status(501).send('Not Implemented: PDF-to-Office conversion requires a specialized paid API for good results.');
  await cleanup([req.file]);
});

// --- 10. PDF to PDF/A ---
app.post('/pdf-to-pdfa', upload.single('file'), async (req, res) => {
  //
  // This requires a tool that understands the PDF/A-1, A-2, A-3 specs.
  // OPTION 1: Paid API (Adobe, etc.)
  // OPTION 2: Server-side tool like Ghostscript.
  //   - `gs -dPDFA -dBATCH -dNOPAUSE -sProcessColorModel=DeviceCMYK -sDEVICE=pdfwrite -sOutputFile=output_pdfa.pdf ${req.file.path}`
  //
  res.status(501).send('Not Implemented: PDF/A conversion requires a paid API or server-side tool like Ghostscript.');
  await cleanup([req.file]);
});

// --- 11. Scan to PDF ---
app.post('/scan-to-pdf', (req, res) => {
  //
  // This is a FRONTEND function, not a backend one.
  // The frontend (your React app) would:
  // 1. Use a JavaScript library (like 'react-webcam') to take a photo.
  // 2. The frontend would then UPLOAD the image(s) to the '/jpg-to-pdf' endpoint we already built.
  //
  res.status(400).send('This is a frontend task. Your app should capture images and send them to the /jpg-to-pdf endpoint.');
});


// --- Start Server ---
app.listen(port, () => {
  console.log(`PDF Backend listening at http://localhost:${port}`);
  // Ensure the upload directory exists on start
  fs.ensureDirSync('uploads/');
});