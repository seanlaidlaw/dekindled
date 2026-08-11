// Simple ZIP implementation for EPUB generation in Chrome extension service workers
// Based on minimal ZIP file format specification

class SimpleZip {
    constructor() {
        this.files = [];
        this.folders = new Set();
    }

    file(path, content, mtime) {
        // Ensure parent folders exist
        const parts = path.split('/');
        let currentPath = '';
        for (let i = 0; i < parts.length - 1; i++) {
            currentPath += (currentPath ? '/' : '') + parts[i];
            this.folders.add(currentPath);
        }

        this.files.push({
            path: path,
            content: typeof content === 'string' ? new TextEncoder().encode(content) : content,
            isFolder: false,
            // Optional per-file modification time (Date). Falls back to "now"
            // at generation if absent. This is what makes extracted files sort
            // by capture time instead of the all-zero 1979 DOS timestamp.
            mtime: (mtime instanceof Date && !isNaN(mtime)) ? mtime : null
        });
    }

    folder(name) {
        this.folders.add(name);
        return {
            file: (path, content) => {
                this.file(`${name}/${path}`, content);
            }
        };
    }

    async generateAsync(options = {}) {
        const zipData = [];
        const centralDirectory = [];
        let offset = 0;

        // Single reference time for folders / any file lacking an mtime, so the
        // local header and central directory always agree for a given entry.
        const zipDate = new Date();

        // Add folders first
        for (const folderPath of this.folders) {
            const folderData = this.createFileEntry(folderPath + '/', new Uint8Array(0), true, zipDate);
            zipData.push(folderData.localFileHeader);

            centralDirectory.push(this.createCentralDirectoryEntry(
                folderPath + '/',
                new Uint8Array(0),
                offset,
                true,
                zipDate
            ));

            offset += folderData.localFileHeader.length;
        }

        // Add files
        for (const file of this.files) {
            const fileDate = file.mtime || zipDate;
            const fileData = this.createFileEntry(file.path, file.content, false, fileDate);
            zipData.push(fileData.localFileHeader);

            centralDirectory.push(this.createCentralDirectoryEntry(
                file.path,
                file.content,
                offset,
                false,
                fileDate
            ));

            offset += fileData.localFileHeader.length;
        }

        // Central directory
        const centralDirStart = offset;
        let centralDirSize = 0;
        
        for (const entry of centralDirectory) {
            zipData.push(entry);
            centralDirSize += entry.length;
        }

        // End of central directory
        const totalEntries = this.folders.size + this.files.length;
        const endOfCentralDir = this.createEndOfCentralDirectory(
            totalEntries, 
            centralDirSize, 
            centralDirStart
        );
        zipData.push(endOfCentralDir);

        // Combine all data
        const totalLength = zipData.reduce((sum, data) => sum + data.length, 0);
        const result = new Uint8Array(totalLength);
        let pos = 0;
        
        for (const data of zipData) {
            result.set(data, pos);
            pos += data.length;
        }

        return new Blob([result], { type: options.mimeType || 'application/zip' });
    }

    // Convert a JS Date to packed MS-DOS time/date words (2-second resolution).
    // DOS can't represent years before 1980, so clamp to the epoch.
    dosDateTime(date) {
        let d = (date instanceof Date && !isNaN(date)) ? date : new Date();
        if (d.getFullYear() < 1980) d = new Date(1980, 0, 1, 0, 0, 0);
        const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
        const dosdate = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
        return { time: time & 0xffff, date: dosdate & 0xffff };
    }

    // Info-ZIP "extended timestamp" extra field (id 0x5455, "UT"), mtime only.
    // Gives 1-second, timezone-correct Unix mtime that most extractors honour —
    // finer than the 2-second DOS field. Same 9 bytes in local + central header.
    extendedTimestampExtra(date) {
        const d = (date instanceof Date && !isNaN(date)) ? date : new Date();
        const unix = Math.floor(d.getTime() / 1000);
        const buf = new Uint8Array(9);
        const dv = new DataView(buf.buffer);
        dv.setUint16(0, 0x5455, true); // header id "UT"
        dv.setUint16(2, 5, true);      // data size: 1 flag byte + 4 mtime bytes
        dv.setUint8(4, 0x01);          // flags: mtime present
        dv.setUint32(5, unix >>> 0, true); // modification time (Unix seconds)
        return buf;
    }

    createFileEntry(filename, content, isFolder, mtime) {
        const nameBytes = new TextEncoder().encode(filename);
        const crc32 = isFolder ? 0 : this.calculateCRC32(content);
        const dt = this.dosDateTime(mtime);
        const extra = this.extendedTimestampExtra(mtime);

        // Local file header
        const header = new Uint8Array(30 + nameBytes.length + extra.length + content.length);
        const view = new DataView(header.buffer);

        // Local file header signature
        view.setUint32(0, 0x04034b50, true);
        // Version needed to extract
        view.setUint16(4, 20, true);
        // General purpose bit flag
        view.setUint16(6, 0, true);
        // Compression method (0 = no compression)
        view.setUint16(8, 0, true);
        // File last modification time / date (MS-DOS packed)
        view.setUint16(10, dt.time, true);
        view.setUint16(12, dt.date, true);
        // CRC-32
        view.setUint32(14, crc32, true);
        // Compressed size
        view.setUint32(18, content.length, true);
        // Uncompressed size
        view.setUint32(22, content.length, true);
        // File name length
        view.setUint16(26, nameBytes.length, true);
        // Extra field length
        view.setUint16(28, extra.length, true);

        // File name, then extra field, then content
        header.set(nameBytes, 30);
        header.set(extra, 30 + nameBytes.length);
        if (content.length > 0) {
            header.set(content, 30 + nameBytes.length + extra.length);
        }

        return { localFileHeader: header };
    }

    createCentralDirectoryEntry(filename, content, offset, isFolder, mtime) {
        const nameBytes = new TextEncoder().encode(filename);
        const crc32 = isFolder ? 0 : this.calculateCRC32(content);
        const dt = this.dosDateTime(mtime);
        const extra = this.extendedTimestampExtra(mtime);

        const entry = new Uint8Array(46 + nameBytes.length + extra.length);
        const view = new DataView(entry.buffer);

        // Central directory file header signature
        view.setUint32(0, 0x02014b50, true);
        // Version made by
        view.setUint16(4, 20, true);
        // Version needed to extract
        view.setUint16(6, 20, true);
        // General purpose bit flag
        view.setUint16(8, 0, true);
        // Compression method
        view.setUint16(10, 0, true);
        // File last modification time / date (MS-DOS packed)
        view.setUint16(12, dt.time, true);
        view.setUint16(14, dt.date, true);
        // CRC-32
        view.setUint32(16, crc32, true);
        // Compressed size
        view.setUint32(20, content.length, true);
        // Uncompressed size
        view.setUint32(24, content.length, true);
        // File name length
        view.setUint16(28, nameBytes.length, true);
        // Extra field length
        view.setUint16(30, extra.length, true);
        // File comment length
        view.setUint16(32, 0, true);
        // Disk number where file starts
        view.setUint16(34, 0, true);
        // Internal file attributes
        view.setUint16(36, 0, true);
        // External file attributes
        view.setUint32(38, isFolder ? 0x10 : 0x20, true);
        // Relative offset of local file header
        view.setUint32(42, offset, true);

        // File name, then extra field
        entry.set(nameBytes, 46);
        entry.set(extra, 46 + nameBytes.length);

        return entry;
    }

    createEndOfCentralDirectory(totalEntries, centralDirSize, centralDirStart) {
        const entry = new Uint8Array(22);
        const view = new DataView(entry.buffer);
        
        // End of central directory signature
        view.setUint32(0, 0x06054b50, true);
        // Number of this disk
        view.setUint16(4, 0, true);
        // Disk where central directory starts
        view.setUint16(6, 0, true);
        // Number of central directory records on this disk
        view.setUint16(8, totalEntries, true);
        // Total number of central directory records
        view.setUint16(10, totalEntries, true);
        // Size of central directory
        view.setUint32(12, centralDirSize, true);
        // Offset of start of central directory
        view.setUint32(16, centralDirStart, true);
        // Comment length
        view.setUint16(20, 0, true);
        
        return entry;
    }

    calculateCRC32(data) {
        // Simple CRC32 implementation
        let crc = 0xFFFFFFFF;
        const table = this.getCRC32Table();
        
        for (let i = 0; i < data.length; i++) {
            const byte = data[i];
            crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xFF];
        }
        
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    getCRC32Table() {
        if (!this._crc32Table) {
            this._crc32Table = new Uint32Array(256);
            for (let i = 0; i < 256; i++) {
                let crc = i;
                for (let j = 0; j < 8; j++) {
                    crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
                }
                this._crc32Table[i] = crc;
            }
        }
        return this._crc32Table;
    }
}

// Export for use in service worker
if (typeof self !== 'undefined' && self.importScripts) {
    self.SimpleZip = SimpleZip;
} 