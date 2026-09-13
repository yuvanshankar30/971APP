package SheetHandler;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.stream.Stream;

import Parser.Sheet.SheetParser;

import java.awt.Graphics;
import java.io.File;

/**
 * Stores the cutFile and holeFile as well as an arraylist of all the parts
 * Also, essentially wraps the Arraylist to make the cut iterable for each part
 */
public class Cut implements Iterable<Part> {
    public final ArrayList<Part> parts = new ArrayList<>();
    private File cutFile;
    private File holeFile;

    public File getHoleFile() {
        return holeFile;
    }

    public Cut(File cutFile, File holeFile) {
        if (cutFile == null) {
            throw new IllegalArgumentException("cutFile must not be null");
        }
        if (holeFile == null) {
            throw new IllegalArgumentException("holeFile must not be null");
        }

        this.holeFile = holeFile;
        this.cutFile = cutFile;

        if (!cutFile.exists()) {
            /*
             * try {
             * if (!cutFile.createNewFile()) {
             * new ErrorDialog(new IOException("This Cut file already exists"));
             * }
             * } catch (IOException e) {
             * new ErrorDialog(e);
             * }
             */
            return;
        }

        SheetParser.parseCutFile(cutFile, this);
    }

    public Stream<Part> stream() {
        return parts.stream();
    }

    public List<Part> getParts() {
        return Collections.unmodifiableList(parts);
    }

    public void addPart(Part part) {
        if (part == null) {
            throw new IllegalArgumentException("part must not be null");
        }
        parts.add(part);
    }

    @Override
    public Iterator<Part> iterator() {
        return parts.iterator();
    }

    public File getCutFile() {
        return cutFile;
    }

    /**
     * Draw the parts and holes in the cut
     */
    public void draw(Graphics g) {
        for (Part part : parts) {
            part.draw(g);
        }
    }
}
