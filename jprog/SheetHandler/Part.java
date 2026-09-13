package SheetHandler;

import Display.ErrorDialog;
import Display.Screen;
import Display.WarningDialog;
import Parser.GCode.NGCDocument;
import Parser.GCode.NgcStrain;
import Parser.GCode.Parser;
import Parser.GCode.RelativePath2D;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.Stroke;
import java.awt.geom.AffineTransform;
import java.awt.geom.Point2D;
import java.awt.geom.Rectangle2D;
import java.io.File;
import java.io.FileNotFoundException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.ConcurrentModificationException;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import javax.swing.SwingUtilities;

/** holds all information and methods related to a part */
public class Part {
    private double sheetX, sheetY, rotation; // x and y in inches, rotation in radians
    protected final List<NGCDocument> activeNgcDocs = new java.util.concurrent.CopyOnWriteArrayList<>();
    private final List<NGCDocument> allNGCDocs = new java.util.concurrent.CopyOnWriteArrayList<>();
    protected NGCDocument emitNGCDoc;
    private File partFile;
    private boolean selected = false;
    private final List<Future<NGCDocument>> futures = new java.util.concurrent.CopyOnWriteArrayList<>(); // holds all future for concurrent gcode file
    // parsing
    private boolean exist = true;

    // private Shape outline;

    public Part(File partFile, double xLoc, double yLoc, double rot) {
        if (partFile == null) {
            throw new NullPointerException("Part File cannot be null!");
        }
        this.partFile = partFile;
        sheetX = xLoc;
        sheetY = yLoc;
        rotation = rot;

        try {
            File[] files;
            if (this instanceof Hole) {
                files = new File[] { partFile };
            } else {
                files = partFile.listFiles();
            }

            File parent = partFile;
            if (files == null) {
                new WarningDialog(new NullPointerException(),
                        "Folder: " + parent.getName() + " Not Found", null);
                exist = false;
                return;
            }

            ArrayList<File> ngcFiles = new ArrayList<>();
            for (File file : files) {
                if (file.getName().lastIndexOf(".") != -1) {
                    String ext = file.getName()
                            .substring(file.getName().lastIndexOf(".") + 1);
                    if (ext.equals("ngc") || ext.equals("tap")) {
                        ngcFiles.add(file);
                    }
                }
            }

            if (ngcFiles.isEmpty()) {
                new ErrorDialog(new FileNotFoundException(),
                        "No NGC File found in: " + parent.getPath());
                exist = false;
                return;
            }

            for (File file : ngcFiles) {
                NGCDocument doc = Parser.parse(file);
                if (allNGCDocs.stream().noneMatch(d -> d.getGcodeFile().equals(file))) {
                    allNGCDocs.add(doc);
                }
            }

            if (activeNgcDocs.isEmpty() && !allNGCDocs.isEmpty()) {
                activeNgcDocs.add(allNGCDocs.get(0));
            }
            if (Screen.screen != null) {
                SwingUtilities.invokeLater(Screen.screen::repaint);
            }
        } catch (ConcurrentModificationException e) {
            new ErrorDialog(e);
        } catch (Exception e) {
            new ErrorDialog(e, "File : " + partFile.getAbsolutePath() + " Not Found");
        }
    }

    /**
     * @return whether this part truly exists or not
     */
    public boolean exists() {
        return exist;
    }

    /** Pretty much reinstantiates this Part */
    public void reload() {
        try {
            // Save the filenames of currently viewed docs so we can restore after reload
            java.util.Set<String> previouslyActive = new java.util.HashSet<>();
            for (NGCDocument doc : activeNgcDocs) {
                previouslyActive.add(doc.getGcodeFile().getName());
            }

            allNGCDocs.clear();
            activeNgcDocs.clear();
            emitNGCDoc = null;
            File[] files = new File[0];
            if (this instanceof Hole) {
                files = new File[] { partFile };
            } else {
                files = partFile.listFiles();
            }
            ArrayList<File> ngcFiles = new ArrayList<>();
            File parent = partFile;
            if (files == null) {
                new ErrorDialog(new NullPointerException(), "Folder: " + parent.getName() + " Not Found");
                exist = false;
                return;
            }
            for (File file : files) {
                if (file.getName().lastIndexOf(".") != -1) {
                    String ext = file.getName()
                            .substring(file.getName().lastIndexOf(".") + 1, file.getName().length());
                    if (ext.equals("ngc") || ext.equals("tap")) {
                        ngcFiles.add(file);
                    }
                }
            }
            if (ngcFiles.isEmpty()) {
                new ErrorDialog(new FileNotFoundException(), "No NGC File found in: " + parent.getPath());
                exist = false;
                return;
            }
            for (File file : ngcFiles) {
                NGCDocument doc = Parser.parse(file);
                if (allNGCDocs.stream().noneMatch(d -> d.getGcodeFile().equals(file))) {
                    allNGCDocs.add(doc);
                }
            }

            activeNgcDocs.clear();
            for (NGCDocument doc : allNGCDocs) {
                if (previouslyActive.contains(doc.getGcodeFile().getName())) {
                    activeNgcDocs.add(doc);
                }
            }
            if (activeNgcDocs.isEmpty() && !allNGCDocs.isEmpty()) {
                activeNgcDocs.add(allNGCDocs.get(0));
            }
            if (Screen.screen != null) {
                SwingUtilities.invokeLater(Screen.screen::repaint);
            }
        } catch (ConcurrentModificationException e) {
            new ErrorDialog(e);
        } catch (Exception e) {
            new ErrorDialog(e, "File : " + partFile.getAbsolutePath() + " Not Found");
        }
    }

    /**
     * @return true if all futures have returned
     */
    protected boolean checkFutures() {
        ArrayList<Future<NGCDocument>> toRemove = new ArrayList<>();
        for (Future<NGCDocument> future : futures) {
            if (future.isDone()) {
                try {
                    NGCDocument resolved = future.get();
                    if (allNGCDocs.stream().noneMatch(d -> d.getGcodeFile().equals(resolved.getGcodeFile()))) {
                        allNGCDocs.add(resolved);
                    }
                } catch (InterruptedException | ExecutionException e) {
                    new ErrorDialog(e);
                }
                toRemove.add(future);
            }
        }
        futures.removeAll(toRemove);
        ensureVisibleDocuments();
        return futures.size() == 0;
    }

    private void ensureVisibleDocuments() {
        if (!activeNgcDocs.isEmpty()) {
            return;
        }
        if (emitNGCDoc != null && !activeNgcDocs.contains(emitNGCDoc)) {
            activeNgcDocs.add(emitNGCDoc);
        }
    }

    /**
     * @return list of all the NGCDocuments this part has
     */
    public List<NGCDocument> getAllNgcDocuments() {
        checkFutures();
        return allNGCDocs;
    }

    public List<NGCDocument> getNgcDocuments() {
        ensureVisibleDocuments();
        return activeNgcDocs;
    }

    /** Makes the file to emit with null */
    public void nullify() {
        emitNGCDoc = null;
    }

    /**
     * Selects the GCode document whose filename suffix matches {@code suffix} and
     * whose {@link NgcStrain} matches the output file's extension (.tap → WinCNC,
     * anything else → router_971). Falls back to a suffix-only match when no
     * strain-specific file is found.
     *
     * @param suffix     the filename suffix to match (e.g. "tool1", "holes")
     * @param outputFile the destination file; its extension determines the target
     *                   strain
     * @return {@code true} if a matching document was found and set
     */
    public boolean setSelectedGCode(String suffix, File outputFile) {
        checkFutures();

        // 1. Determine Target Strain based on output file extension
        String outExt = "";
        if (outputFile != null) {
            String name = outputFile.getName();
            outExt = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1) : "";
        }

        NgcStrain targetStrain;
        if (outExt.equalsIgnoreCase("tap")) {
            targetStrain = NgcStrain.router_WinCNC;
        } else {
            targetStrain = NgcStrain.router_971;
        }

        // 2. PASS 1: Find Exact Match (Suffix AND Strain)
        for (NGCDocument ngcDocument : allNGCDocs) {
            String fileName = ngcDocument.getGcodeFile().getName();
            int lastUnderscore = fileName.lastIndexOf('_');
            int dotIndex = fileName.lastIndexOf('.');
            String fileSuffix = fileName.substring(lastUnderscore == -1 ? 0 : lastUnderscore + 1,
                    dotIndex == -1 ? fileName.length() : dotIndex);

            if (suffix.equals(fileSuffix) && ngcDocument.getNgcStrain() == targetStrain) {
                emitNGCDoc = ngcDocument;
                return true;
            }
        }

        // 3. PASS 2: Fallback (Suffix Only)
        // If we didn't find the specific strain (e.g. only .ngc exists but we want
        // .tap), take what we
        // have.
        for (NGCDocument ngcDocument : allNGCDocs) {
            String fileName = ngcDocument.getGcodeFile().getName();
            int lastUnderscore = fileName.lastIndexOf('_');
            int dotIndex = fileName.lastIndexOf('.');
            String fileSuffix = fileName.substring(lastUnderscore == -1 ? 0 : lastUnderscore + 1,
                    dotIndex == -1 ? fileName.length() : dotIndex);

            if (suffix.equals(fileSuffix)) {
                emitNGCDoc = ngcDocument;
                return true;
            }
        }
        emitNGCDoc = null;

        return false;
    }

    /**
     * @return the current active emit NGCDocument
     */
    public NGCDocument getNgcDocument() {
        return emitNGCDoc;
    }

    /**
     * @return an array of all the suffixes of gcode files
     */
    public String[] getSuffixes() {
        if (this instanceof Hole) {
            return new String[] { "holes" };
        }
        checkFutures();
        String[] suffixes = new String[allNGCDocs.size()];
        for (int i = 0; i < suffixes.length; i++) {
            String fileName = allNGCDocs.get(i).getGcodeFile().getName();
            int lastUnderscore = fileName.lastIndexOf('_');
            int dotIndex = fileName.lastIndexOf('.');
            suffixes[i] = fileName.substring(lastUnderscore == -1 ? 0 : lastUnderscore + 1,
                    dotIndex == -1 ? fileName.length() : dotIndex);
        }
        return suffixes;
    }

    /**
     * @param doc adds this the list of NGDocuments to be drawn
     */
    public void addActiveGcode(NGCDocument doc) {
        checkFutures();
        if (!allNGCDocs.stream().anyMatch(e -> e.equals(doc))) {
            throw new IllegalArgumentException("GCode doc dothe not appataine to this part");
        }
        if (!activeNgcDocs.contains(doc)) {
            activeNgcDocs.add(doc);
        }
    }

    /**
     * @param doc removes this the list of NGDocuments to be drawn
     */
    public void removeActiveGcode(NGCDocument doc) {
        checkFutures();
        activeNgcDocs.remove(doc);
    }

    

    public boolean contains(Point2D point) {
        if (activeNgcDocs.isEmpty() && allNGCDocs.isEmpty()) {
            Point2D.Double pointToCheck = new Point2D.Double(point.getX(), -point.getY());
            pointToCheck.setLocation(pointToCheck.getX() + sheetX, pointToCheck.getY() + sheetY);
            pointToCheck.setLocation(
                    pointToCheck.getX() * Math.cos(-rotation)
                            + pointToCheck.getY() * -Math.sin(-rotation),
                    pointToCheck.getX() * Math.sin(-rotation)
                            + pointToCheck.getY() * Math.cos(-rotation));
            pointToCheck.setLocation(-pointToCheck.getX(), pointToCheck.getY());
            return new Rectangle2D.Double(-0.75, -0.75, 1.5, 1.5).contains(pointToCheck);
        }

        for (NGCDocument activeNgcDoc : activeNgcDocs) {
            // CHANGE: Iterate through layers to get the specific tool for each path
            HashMap<Integer, ArrayList<RelativePath2D>> layers = activeNgcDoc.getToolpathLayers();

            for (Integer toolNum : layers.keySet()) {
                // 1. Get the visual thickness (Tool Diameter)
                double radius = activeNgcDoc.getToolOffset(toolNum).toolRadius();
                float strokeWidth = (float) (radius * 2.0);

                // Ensure it's at least clickable (e.g., 0.1 inches) even if tool is tiny
                if (strokeWidth < 0.1f) {
                    strokeWidth = 0.1f;
                }

                // 2. Create a stroke to represent the physical cut width
                BasicStroke stroke = new BasicStroke(strokeWidth, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND);

                for (RelativePath2D path : layers.get(toolNum)) {
                    // --- Coordinate Transformation (Unchanged) ---
                    Point2D.Double pointToCheck = new Point2D.Double(point.getX(), -point.getY());
                    pointToCheck.setLocation(pointToCheck.getX() + sheetX, pointToCheck.getY() + sheetY);

                    pointToCheck.setLocation(
                            pointToCheck.getX() * Math.cos(-rotation)
                                    + pointToCheck.getY() * -Math.sin(-rotation),
                            pointToCheck.getX() * Math.sin(-rotation)
                                    + pointToCheck.getY() * Math.cos(-rotation));

                    pointToCheck.setLocation(-pointToCheck.getX(), pointToCheck.getY());
                    // ---------------------------------------------

                    // 3. Check if point is ON the line (Stroke) OR INSIDE the shape
                    if (stroke.createStrokedShape(path).contains(pointToCheck)
                            || path.contains(pointToCheck)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    public void setSelected(boolean selected) {
        this.selected = selected;
    }

    public boolean getSelected() {
        return selected;
    }

    public double getX() {
        return sheetX;
    }

    public Rectangle2D getCenterPoint() {
        NGCDocument ngcDoc = emitNGCDoc;
        if (ngcDoc == null && !activeNgcDocs.isEmpty()) {
            ngcDoc = activeNgcDocs.get(0);
        }
        if (ngcDoc == null) {
            return new java.awt.geom.Rectangle2D.Double();
        }
        HashMap<Integer, ArrayList<RelativePath2D>> layers = ngcDoc.getToolpathLayers();
        Rectangle2D boundingBox = null;
        for (Integer toolNum : layers.keySet()) {
            for (RelativePath2D path : layers.get(toolNum)) {
                if (boundingBox == null) {
                    boundingBox = path.getBounds2D();
                } else {
                    Rectangle2D.union(boundingBox, path.getBounds2D(), boundingBox);
                }
            }
        }
        return boundingBox;
    }

    public void setX(double x) {
        sheetX = x;
    }

    public double getY() {
        return sheetY;
    }

    public void setY(double y) {
        sheetY = y;
    }

    public double getRot() {
        return rotation;
    }

    public void setRot(double rot) {
        rotation = rot;
    }

    public File partFile() {
        return partFile;
    }

    /**
     * translates the reference frame to the part, then draws all RelativePath2Ds
     * from each Active
     * NGCDocument
     *
     * @param g Graphics instance to be drawn to
     */
    public void draw(Graphics g) {
        checkFutures();
        Graphics2D g2d = (Graphics2D) g;
        AffineTransform prevTransform = g2d.getTransform();
        g2d.translate(sheetX, -sheetY);
        Color prevColor = g.getColor();
        g2d.rotate(-rotation);
        if (selected == true) {
            g.setColor(Color.RED);
        }
        Stroke currentStrok = g2d.getStroke();

        if (activeNgcDocs.isEmpty() && allNGCDocs.isEmpty()) {
            g2d.setColor(prevColor);
            g2d.setStroke(currentStrok);
            g2d.setTransform(prevTransform);
            return;
        }
        for (NGCDocument activeNgcDoc : activeNgcDocs) {
            HashMap<Integer, ArrayList<RelativePath2D>> layers = activeNgcDoc.getToolpathLayers();
            for (Integer toolNum : layers.keySet()) {
                double radius = activeNgcDoc.getToolOffset(toolNum).toolRadius();
                float strokeWidth = (float) (radius * 2.0);
                if (strokeWidth <= 0.001)
                    strokeWidth = 0.01f;
                g2d.setStroke(
                        new BasicStroke(strokeWidth, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND, 100000));
                layers.get(toolNum).forEach(e -> g2d.draw(e));
            }
        }
        g2d.setColor(prevColor);
        g2d.setStroke(currentStrok);
        g2d.setTransform(prevTransform);
    }

    public boolean equivalent(Object obj) {
        if (((Part) obj).getSelected()) {
            return true;
        }
        return false;
    }

    /*
     * @Deprecated
     * public void generateOutline() {
     * // outline = new Area(ngcDoc.getCurrentPath2D());
     * Stroke stroke = new BasicStroke((float) activeNgcDoc.getToolOffset(),
     * BasicStroke.CAP_ROUND,
     * BasicStroke.JOIN_ROUND,
     * 0);
     * // Area strokeShape = new Area(stroke.createStrokedShape(outline));
     *
     * RelativePath2D temp = activeNgcDoc.getCurrentPath2D();
     * for (RelativePath2D path : activeNgcDoc.getRelativePath2Ds()) {
     * if (calcArea(path.getBounds2D()) > calcArea(temp.getBounds2D())) {
     * temp = path;
     * }
     * }
     *
     * outline = stroke.createStrokedShape(temp);
     * }
     */

    // public void generateOutline() {
    // //outline = new Area(ngcDoc.getCurrentPath2D());
    // Stroke stroke = new BasicStroke((float) ngcDoc.getToolOffset(),
    // BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND, 0);
    // //Area strokeShape = new Area(stroke.createStrokedShape(outline));

    // RelativePath2D temp = ngcDoc.getCurrentPath2D();
    // for (RelativePath2D path : ngcDoc.getRelativePath2Ds()) {
    // if(calcArea(path.getBounds2D()) > calcArea(temp.getBounds2D())){
    // temp = path;
    // }
    // }

    // outline = stroke.createStrokedShape(temp);
    // }

    // private double calcArea(Rectangle2D rect){
    // return rect.getWidth()*rect.getHeight();
    // }
}