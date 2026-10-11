// Prints what ReplayGainReader finds in every file of a folder (see run.sh).
import com.scell.novelreader.redesign.ReplayGainReader
import java.io.File
fun main(args: Array<String>) {
    for (f in File(args[0]).listFiles()!!.sortedBy { it.name }) {
        if (f.extension == "bak") continue
        val r = ReplayGainReader.read(f)
        println("${f.name}: " + (r?.let { "track=${it.trackDb} album=${it.albumDb} tpeak=${it.trackPeak} apeak=${it.albumPeak}" } ?: "null"))
    }
}
