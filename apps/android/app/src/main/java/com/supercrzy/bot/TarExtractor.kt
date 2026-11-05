package com.supercrzy.bot

import android.os.Build
import android.system.Os
import java.io.File
import java.util.zip.GZIPInputStream

/**
 * Minimal streaming tar.gz extractor.
 *
 * Why hand-rolled: Android ships no tar, and the runtime archive must land under
 * filesDir with symlinks intact (node_modules is full of them). Java's zip APIs do
 * not cover either. Headers we accept: ustar, GNU long names ('L'), pax ('x');
 * everything else is skipped by size so the stream never desyncs.
 */
object TarExtractor {

    /** Extracts a .tar.gz into [dest]. Returns the number of entries written. */
    fun extractGzip(archive: File, dest: File): Int {
        dest.mkdirs()
        var count = 0
        GZIPInputStream(archive.inputStream().buffered(1 shl 16)).use { input ->
            val header = ByteArray(512)
            var pendingName: String? = null

            while (true) {
                if (!readFully(input, header)) break
                if (isZeroBlock(header)) {
                    // Two zero blocks terminate the archive; one is enough for us.
                    break
                }

                val size = octal(header, 124, 12)
                val typeFlag = header[156].toInt().toChar()
                var name = str(header, 0, 100)
                val prefix = str(header, 345, 155)
                if (prefix.isNotEmpty()) name = "$prefix/$name"
                pendingName?.let { longName ->
                    name = longName
                    pendingName = null
                }
                name = name.removePrefix("./")

                when (typeFlag) {
                    'L' -> { // GNU long name: next header is the real payload's header.
                        pendingName = readData(input, size).decodeToString().trimEnd('\u0000')
                        continue
                    }
                    'x', 'g' -> { readData(input, size); continue } // pax metadata
                }

                val target = File(dest, name)
                when (typeFlag) {
                    '5' -> target.mkdirs()
                    '0', '\u0000', '7' -> {
                        target.parentFile?.mkdirs()
                        val out = target.outputStream()
                        var left = size
                        val buf = ByteArray(1 shl 16)
                        while (left > 0) {
                            val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                            if (n <= 0) break
                            out.write(buf, 0, n)
                            left -= n
                        }
                        out.close()
                        val mode = octal(header, 100, 8)
                        if (mode and 0o111 != 0) target.setExecutable(true, false)
                        count++
                    }
                    '2' -> { // symlink
                        target.parentFile?.mkdirs()
                        target.delete()
                        val link = str(header, 157, 100)
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                            runCatching { Os.symlink(link, target.absolutePath) }
                                .onFailure { target.writeText(link) } // best effort copy
                        } else {
                            target.writeText(link)
                        }
                        count++
                    }
                    '1' -> { // hard link: materialize as a copy of the first entry
                        val src = File(dest, str(header, 157, 100))
                        target.parentFile?.mkdirs()
                        src.copyTo(target, overwrite = true)
                        count++
                    }
                    else -> readData(input, size) // unknown type: skip payload, stay in sync
                }
                // Entries are padded to 512-byte blocks; 'L'/'x' already consumed above.
                if (typeFlag !in "Lx") {
                    val padding = (512 - (size % 512)) % 512
                    if (padding > 0) {
                        val skip = ByteArray(padding)
                        if (!readFully(input, skip)) break
                    }
                }
            }
        }
        return count
    }

    private fun isZeroBlock(b: ByteArray): Boolean = b.all { it == 0.toByte() }

    private fun readFully(input: java.io.InputStream, buf: ByteArray): Boolean {
        var off = 0
        while (off < buf.size) {
            val n = input.read(buf, off, buf.size - off)
            if (n <= 0) return false
            off += n
        }
        return true
    }

    private fun readData(input: java.io.InputStream, size: Long): ByteArray {
        val data = ByteArray(size.toInt())
        var off = 0
        while (off < size) {
            val n = input.read(data, off, (size - off).toInt())
            if (n <= 0) break
            off += n
        }
        val padding = ((512 - (size % 512)) % 512).toInt()
        if (padding > 0) {
            val skip = ByteArray(padding)
            readFully(input, skip)
        }
        return data
    }

    private fun str(header: ByteArray, off: Int, len: Int): String {
        val end = header.indexOf(0.toByte(), off).let { if (it in off until off + len) it else off + len }
        return String(header, off, end - off, Charsets.UTF_8).trim()
    }

    private fun octal(header: ByteArray, off: Int, len: Int): Long {
        val text = str(header, off, len).trim(' ', '\u0000')
        if (text.isEmpty()) return 0
        return if (text[0] in '0'..'7') text.toLong(8)
        else text.toLongOrNull() ?: 0L // base-256 (GNU) sizes start with a high bit set
    }
}
