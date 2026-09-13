package SheetHandler;

import Parser.GCode.NGCDocument;
import Display.Screen;
import javax.swing.SwingUtilities;
import java.util.concurrent.Future;
import Parser.GCode.RelativePath2D;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.Stroke;
import java.awt.geom.AffineTransform;
import java.awt.geom.Ellipse2D;
import java.io.File;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;

/**
 * Holes are essentially identical to Parts besides drawing.
 * GCode selection delegates entirely to Part.setSelectedGCode() — no drill
 * cycle generation.
 */
public class Hole extends Part {
    public static final double HEAD_SIZE = Double.parseDouble(Settings.settings.get("ScrewHeadSize"));
    private final Path holeFile;

    public Hole(Path holeFile, double x, double y, double rot) {
        super(holeFile.toFile(), x, y, rot);
        this.holeFile = holeFile;

        // Load the alternate extension (.ngc <-> .tap) if it exists alongside the
        // primary hole file, so both machine strains have a document available.
        try {
            String fileName = holeFile.getFileName().toString();
            String baseName = fileName.contains(".")
                    ? fileName.substring(0, fileName.lastIndexOf('.'))
                    : fileName;
            String originalExt = fileName.contains(".")
                    ? fileName.substring(fileName.lastIndexOf('.') + 1)
                    : "";

            String altExt = originalExt.equalsIgnoreCase("ngc") ? "tap" : "ngc";
            Path altPath = holeFile.resolveSibling(baseName + "." + altExt);

            if (altPath.toFile().exists()) {
                if (Screen.DebugMode) {
                    NGCDocument altDoc = Parser.GCode.Parser.parse(altPath.toFile());
                    getAllNgcDocuments().add(altDoc);
                } else {
                    Future<NGCDocument> fut = Sheet.executor.submit(new Parser.GCode.Parser(altPath.toFile()));
                    // when the future completes, add it to the list and repaint UI
                    Sheet.executor.submit(() -> {
                        try {
                            NGCDocument doc = fut.get();
                            // add to the part's NGCDocument list via accessor
                            java.util.List<NGCDocument> list = getAllNgcDocuments();
                            if (list.stream().noneMatch(d -> d.getGcodeFile().equals(doc.getGcodeFile()))) {
                                list.add(doc);
                            }
                            SwingUtilities.invokeLater(() -> {
                                if (Screen.screen != null) Screen.screen.repaint();
                            });
                        } catch (Exception ex) {
                            System.err.println("Failed to parse alternate hole file: " + altPath);
                        }
                    });
                }
            }
        } catch (Exception e) {
            System.err.println("Failed to load alternative hole file.");
            e.printStackTrace();
        }
    }

    /**
     * Selects the GCode for this hole.
     * Only responds to the "holes" suffix; all matching logic is handled by the
     * parent class exactly as it is for regular parts — no drill cycle fallback.
     */
    @Override
    public boolean setSelectedGCode(String suffix, File outputFile) {
        if (!suffix.equals("holes")) {
            emitNGCDoc = null;
            return false;
        }

        // Determine target strain from output file extension
        String outExt = "";
        if (outputFile != null) {
            String name = outputFile.getName();
            outExt = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1) : "";
        }
        Parser.GCode.NgcStrain targetStrain = outExt.equalsIgnoreCase("tap")
                ? Parser.GCode.NgcStrain.router_WinCNC
                : Parser.GCode.NgcStrain.router_971;

        // Pass 1: find exact strain match
        for (NGCDocument doc : getAllNgcDocuments()) {
            if (doc.getNgcStrain() == targetStrain) {
                emitNGCDoc = doc;
                return true;
            }
        }

        // Pass 2: fallback to any available document
        if (!getAllNgcDocuments().isEmpty()) {
            emitNGCDoc = getAllNgcDocuments().get(0);
            return true;
        }

        emitNGCDoc = null;
        return false;
    }

    @Override
    public void draw(Graphics g) {
        Graphics2D g2d = (Graphics2D) g;
        AffineTransform prevTransform = g2d.getTransform();
        g2d.translate(getX(), -getY());
        Color prevColor = g.getColor();
        g2d.rotate(-getRot());

        if (getSelected()) {
            g.setColor(Color.RED);
        }

        Stroke currentStroke = g2d.getStroke();

        for (NGCDocument activeNgcDoc : getNgcDocuments()) {
            HashMap<Integer, ArrayList<RelativePath2D>> layers = activeNgcDoc.getToolpathLayers();
            for (Integer toolNum : layers.keySet()) {
                double radius = activeNgcDoc.getToolOffset(toolNum).toolRadius();
                float strokeWidth = (float) (radius * 2.0);
                if (strokeWidth <= 0.001f)
                    strokeWidth = 0.01f;

                g2d.setStroke(new BasicStroke(strokeWidth, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND, 100000));
                layers.get(toolNum).forEach(e -> g2d.draw(e));
            }
        }

        g2d.setStroke(currentStroke);
        g2d.setColor(Color.ORANGE);
        g2d.draw(new Ellipse2D.Double(-HEAD_SIZE / 2, -HEAD_SIZE / 2, HEAD_SIZE, HEAD_SIZE));
        g2d.setColor(prevColor);
        g2d.setTransform(prevTransform);
    }
}