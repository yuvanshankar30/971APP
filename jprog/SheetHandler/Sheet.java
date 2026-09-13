package SheetHandler;

import Display.Screen;
import Display.WarningDialog;
import Parser.GCode.NGCDocument;
import Parser.GCode.NgcStrain;
import Parser.GCode.ToolInfo;
import Parser.Sheet.SheetParser;
import java.awt.Color;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.geom.Point2D;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileWriter;
import java.io.IOException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.Objects;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.stream.Collectors;
import javax.swing.SwingUtilities;

public class Sheet {
    private ArrayList<Cut> cuts;
    private Cut activeCut;
    private double width, height; // in inches
    private File sheetFile, activeCutFile, parentFile;
    private Path holeFile;
    // static threadpool to avoid instantiation cost but allow multithreaded gcode
    // parsing
    public static ThreadPoolExecutor executor = (ThreadPoolExecutor) Executors.newFixedThreadPool(10);

    /**
     * Declares a new sheet from a file
     *
     * @param sheetFile - the .sheet file to get the information from
     */
    public Sheet(File sheetFile) {
        this.sheetFile = sheetFile;
        cuts = new ArrayList<>();

        HashMap<String, String> decodedFile = SheetParser.parseSheetFile(sheetFile);

        String widthValue = decodedFile.get("w");
        String heightValue = decodedFile.get("h");
        String holeFileValue = decodedFile.get("hole_file");
        if (widthValue == null || heightValue == null || holeFileValue == null || holeFileValue.isBlank()) {
            throw new IllegalArgumentException("Sheet file is missing required dimensions or hole file data: " + sheetFile);
        }

        width = Double.parseDouble(widthValue);
        height = Double.parseDouble(heightValue);
        holeFile = Paths.get(holeFileValue);
        String activeFile = decodedFile.getOrDefault("active", null);
        activeCutFile = activeFile == null ? null : new File(activeFile);

        // time to get the parts
        parentFile = sheetFile.getParentFile();
        if (parentFile == null || !parentFile.isDirectory()) {
            throw new IllegalArgumentException("Sheet file parent directory is invalid: " + sheetFile);
        }
        File[] siblingFiles = parentFile.listFiles();
        if (siblingFiles != null) {
            for (File cutFile : siblingFiles) {
                if (!cutFile.getName().endsWith(".cut")) {
                    continue;
                }
                Cut newCut = new Cut(cutFile, holeFile.toFile());
                cuts.add(newCut);
                if (activeCutFile != null && cutFile.getName().equals(activeCutFile.getName())) {
                    activeCut = newCut;
                }
            }
        }

        // If no active cut was resolved (missing "active" key or file not found),
        // fall back to the first available cut so the sheet is immediately usable.
        if (activeCut == null && !cuts.isEmpty()) {
            activeCut = cuts.get(0);
            activeCutFile = activeCut.getCutFile();
        }
    }

    public File getParentFile() {
        return parentFile;
    }

    public ArrayList<Cut> getCuts() {
        return cuts;
    }

    public File getHolesFile() {
        return holeFile.toFile();
    }

    public void changeActiveCutFile(File newCut) {
        if (newCut == null || newCut == activeCutFile) {
            return;
        }

        activeCut = cuts.stream()
                .filter(e -> e.getCutFile().equals(newCut))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Cut file not found in sheet: " + newCut));
        activeCutFile = activeCut.getCutFile();
        refreshCutLabel();
    }

    public void removePart(Part part) {
        if (activeCut == null || part == null) {
            return;
        }
        activeCut.parts.remove(part);
    }

    /**
     * Declare a new sheet from a path to the list of sheets and the name of the
     * sheet
     */
    public Sheet(
            File sheetFolder, String sheetName, double width, double height, SheetThickness thickness) {
        try {
            File parentFile = new File(sheetFolder, sheetName);
            parentFile.mkdir();
            sheetFile = new File(parentFile, sheetName + ".sheet");
            HashMap<String, String> sheetInfo = new HashMap<>();
            sheetInfo.put("w", "" + width);
            sheetInfo.put("h", "" + height);
            sheetInfo.put("hole_file", thickness.holesFile.toString().replace("\\", "/"));
            SheetParser.saveSheetInfo(sheetFile, sheetInfo);
        } catch (Exception e) {
            System.err.println("Could not create sheet file\n\n");
        }

        this.width = width;
        this.height = height;
    }

    /**
     * returns the width of the sheet
     *
     * @return the width of the sheet
     */
    public double getWidth() {
        return width;
    }

    /**
     * returns the height of the sheet
     *
     * @return the height of the sheet
     */
    public double getHeight() {
        return height;
    }

    /** Adds a part to the active cut; */
    public void addPart(Part part) {
        if (activeCut == null) {
            throw new IllegalStateException("No active cut set. Create or select a cut before adding parts.");
        }
        activeCut.parts.add(part);
    }

    /** Creates a new part and adds it to the active cut */
    public Part addPart(File partFileToPlace, double x, double y) {
        if (activeCut == null) {
            throw new IllegalStateException("No active cut set. Create or select a cut before adding parts.");
        }
        Part part = new Part(partFileToPlace, x, y, 0);
        if (part != null)
            addPart(part);
        return part;
    }

    /** Adds a hole to the active cut */
    public void addHole(Hole hole) {
        if (activeCut == null) {
            throw new IllegalStateException("No active cut set. Create or select a cut before adding holes.");
        }
        activeCut.parts.add(hole);
    }

    /** Adds a new hole to the active cut at the specified position */
    public Hole addHole(double x, double y) {
        if (activeCut == null) {
            throw new IllegalStateException("No active cut set. Create or select a cut before adding holes.");
        }
        Hole hole = new Hole(holeFile, x, y, 0);
        addHole(hole);
        return hole;
    }

    /** Adds a cut to the list and sets it as active */
    public void addCut(Cut cut) {
        activeCut = cut;
        activeCutFile = cut.getCutFile();
        cuts.add(cut);
        refreshCutLabel();
    }

    private void refreshCutLabel() {
        if (Screen.screen == null) {
            return;
        }
        if (SwingUtilities.isEventDispatchThread()) {
            Screen.screen.updateCutNameLabel();
        } else {
            SwingUtilities.invokeLater(Screen.screen::updateCutNameLabel);
        }
    }

    /** Draw the sheet to the screen */
    public void draw(Graphics g) {
        g.setColor(Color.ORANGE);
        g.drawRect(0, 0, (int) Math.abs(width), (int) (height));
        Graphics2D g2d = (Graphics2D) g;
        g2d.translate(-width, height);
        for (Cut cut : cuts) {
            if (cut == activeCut) {
                g.setColor(Color.GREEN);
            } else {
                g.setColor(Color.BLUE);
            }
            cut.draw(g);
        }
        g2d.translate(width, -height);
    }

    /** save the sheet and its cuts */
    public void saveToFile() {
        HashMap<String, String> sheetInfo = new HashMap<>();
        sheetInfo.put("w", "" + width);
        sheetInfo.put("h", "" + height);
        if (holeFile != null) {
            sheetInfo.put("hole_file", holeFile.toString().replace("\\", "/"));
        }
        if (activeCutFile != null) {
            String activePath = activeCutFile.getPath().replace("\\", "/");
            sheetInfo.put("active", activePath.contains("./") ? activePath.substring(activePath.indexOf("./")) : activePath);
        }

        // save sheet info
        SheetParser.saveSheetInfo(sheetFile, sheetInfo);

        // save cuts
        for (Cut cut : cuts) {
            SheetParser.saveCutInfo(cut);
        }
    }

    public Part contains(Point2D point) {
        if (activeCut == null) {
            return null;
        }
        Point2D pointToCheck = new Point2D.Double(-width - point.getX(), height - point.getY());
        for (Part part : activeCut) {
            if (part.contains(pointToCheck)) {
                return part;
            }
        }
        return null;
    }

    public File getActiveCutFile() {
        return activeCutFile;
    }

    public File getSheetFile() {
        return sheetFile;
    }

    /**
     * Emits the gCode from the active cut into the given file
     *
     * @param gCodeFile - the file to put the GCode into.
     * @param string
     */
    public void emitGCode(
            File gCodeFile,
            String suffix,
            Point2D origin,
            List<Integer>... toolOrderArr) {

        // specific mechanics: sandwich each part between a translation to and from
        // their position

        // additionally, for each header that's the same aside from comments, merge
        // it and put it at the start

        // and same for footers except put them at the end
        try {
            if (activeCut == null) {
                new WarningDialog(new IllegalStateException(), "No active cut selected to emit GCode", null);
                return;
            }
            activeCut.stream().forEach((Part p) -> p.setSelectedGCode(suffix, gCodeFile));
            var docs = activeCut.stream()
                    .map(Part::getNgcDocument)
                    .filter(Objects::nonNull)
                    .collect(Collectors.toList());
            if (docs.isEmpty()) {
                new WarningDialog(new IllegalStateException(), "No GCode selected for any parts", null);
                return;
            }
            var strains = docs.stream().map(NGCDocument::getNgcStrain).collect(Collectors.toList());
            String outExt = "";
            if (gCodeFile != null) {
                String fileName = gCodeFile.getName();
                outExt = fileName.contains(".") ? fileName.substring(fileName.lastIndexOf('.') + 1) : "";
            }
            NgcStrain expectedStrain = outExt.equalsIgnoreCase("tap") ? NgcStrain.router_WinCNC : NgcStrain.router_971;

            boolean mixedFormats = strains.stream().distinct().count() > 1;
            if (mixedFormats) {
                // Log a short warning rather than showing a blocking dialog — the UI
                // emit panel displays an inline error indicator for mixed formats.
                Screen.logger.warning(
                        "Mixed formats detected in cut: "
                                + strains.stream().distinct().map(Object::toString).collect(Collectors.joining(", ")));
            }
            NgcStrain predominantStrain = expectedStrain;
            if (!strains.contains(expectedStrain)) {
                predominantStrain = strains.get(0);
            }

            if (!areToolTablesConsistent(docs)) {
                new WarningDialog(
                        new IllegalArgumentException(),
                        "Tool tables for selected files are inconsistent: " + "Undefined Behavior",
                        null);
                System.out.println(docs.toString());
                System.out.println(
                        "Files: \n"
                                + docs.stream()
                                        .map(NGCDocument::getToolTable)
                                        .map(
                                                map -> map.entrySet().stream()
                                                        .filter(e -> !e.getKey().equals(0))
                                                        .map(e -> e.getKey() + "=" + e.getValue())
                                                        .collect(Collectors.joining(", ", "{", "}")))
                                        .collect(Collectors.joining(", ")));
                return; // Stop emit — do not create or write to the file
            }

            List<Integer> toolOrder;
            Map<Integer, ToolInfo> toolTable = getMasterToolTable(docs);

            if (predominantStrain != NgcStrain.router_971) {
                if (toolOrderArr.length > 1) {
                    throw new IllegalArgumentException("Only one tool order allowed");
                }
                if (toolOrderArr.length == 1) {
                    toolOrder = toolOrderArr[0];
                } else {
                    toolOrder = new ArrayList<>(toolTable.keySet());
                }
                Set<Integer> toolTableNonZero = toolTable.keySet().stream()
                        .filter(k -> k != 0)
                        .collect(Collectors.toSet());
                if (!(toolTableNonZero.containsAll(toolOrder)
                        && toolOrder.containsAll(toolTableNonZero))) {
                    throw new IllegalArgumentException(
                            "Master Tool Table and Tool Order aren't consistent: "
                                    + toolOrder.toString()
                                    + " - master: "
                                    + toolTableNonZero.toString());
                }
            } else {
                toolOrder = Collections.singletonList(1);
            }
            gCodeFile.createNewFile();

            BufferedWriter writer = new BufferedWriter(new FileWriter(gCodeFile));
            final String openBracket = predominantStrain == NgcStrain.router_WinCNC ? "[" : "(";
            final String closeBracket = predominantStrain == NgcStrain.router_WinCNC ? "]" : ")";

            if (predominantStrain == NgcStrain.router_971) {
                writer.write("%\n");
            }

            // 2. Write Master Tool Table with Dynamic Brackets
            writer.write(openBracket + "Master Tool Table" + closeBracket + "\n");
            toolTable.entrySet().stream()
                    .filter(e -> e.getKey() != 0)
                    .sorted(Map.Entry.comparingByKey())
                    .forEach(
                            e -> {
                                try {
                                    double diam = e.getValue().toolRadius() * 2;
                                    // Format: (T# D=Diameter) or [T# D=Diameter]
                                    String comment = String.format(
                                            "%sT%d D=%.4f%s\n", openBracket, e.getKey(), diam, closeBracket);
                                    writer.write(comment);
                                } catch (IOException ex) {
                                    ex.printStackTrace();
                                }
                            });

            String header = "";
            String footer = "";
            activeCut.stream().forEach(Part::nullify);
            ArrayList<Part> notEmittedParts = new ArrayList<>();
            for (Integer toolNum : toolOrder) {
                // --- STEP 1: Gather valid parts for this tool ---
                List<Part> partsForTool = new ArrayList<>();
                for (Part part : activeCut) {
                    // Ensure the part has the correct GCode selected
                    if (!part.setSelectedGCode(suffix, gCodeFile)) {
                        // Only log warnings once (handled by the else block logic below if
                        // needed)
                        if (!(suffix.equals("holes")
                                || part instanceof Hole
                                || notEmittedParts.stream()
                                        .anyMatch(p -> p.partFile().getName().equals(part.partFile().getName())))) {
                            new WarningDialog(
                                    new FileNotFoundException(), part.partFile().getName() + " missing gcode", null);
                            notEmittedParts.add(part);
                        }
                        continue;
                    }

                    // Check if part uses this tool (code is not empty)
                    // Note: We use the tool-specific transform here to check validity
                    String testCode;
                    if (predominantStrain == NgcStrain.router_971)
                        testCode = predominantStrain.gCodeParser.gCodeTransformClean(part, origin);
                    else
                        testCode = predominantStrain.gCodeParser.gCodeTransformClean(part, toolNum, origin);

                    if (!testCode.trim().isEmpty()) {
                        partsForTool.add(part);
                    }
                }

                // --- STEP 2: Optimize the order for THIS tool ---
                List<Part> sortedParts = getOptimizedPartOrder(partsForTool);

                String currentMachineSpeed = "";

                boolean toolChangeWritten = false;

                for (Part part : sortedParts) {

                    String partHeader = "";
                    String partBody = "";

                    if (predominantStrain.gCodeParser instanceof Parser.GCode.GCodeParserWinCNC wincncParser) {
                        String rawCode = part.getNgcDocument().getGCodeForTool(toolNum);

                        // Call the new method directly via cast
                        Parser.GCode.GCodeParserWinCNC.ProcessedPart pp = wincncParser.processPart(part, rawCode,
                                origin);

                        // Check redundancy
                        if (toolChangeWritten
                                && pp.startSpeed != null
                                && pp.startSpeed.equals(currentMachineSpeed)) {
                            // Skip header (Spindle Start/Dwell)
                            partHeader = "";
                        } else {
                            partHeader = pp.header;
                        }
                        partBody = pp.body;

                        // Update State
                        if (pp.endSpeed != null)
                            currentMachineSpeed = pp.endSpeed;
                        else if (pp.startSpeed != null)
                            currentMachineSpeed = pp.startSpeed;

                    } else {
                        if (predominantStrain == NgcStrain.router_971) {
                            partBody = predominantStrain.gCodeParser.gCodeTransformClean(part, origin);
                            if (toolChangeWritten) {
                                partBody = partBody
                                    .replaceAll("(?m)^T\\d+ M6\\s*\\R", "")
                                    .replaceAll("(?m)^S\\d+ M3\\s*\\R", "")
                                    .replaceAll("(?m)^G4 P[\\d.]+\\s*\\R", "")
                                    .replaceAll("(?m)^G43.*\\R", "");
                            }
                        } else {
                            partBody = predominantStrain.gCodeParser.gCodeTransformClean(part, toolNum, origin);
                        }
                        partHeader = "";
                    }

                    if ((partHeader + partBody).trim().isEmpty())
                        continue;

                    // 2. WRITE TO FILE
                    if (!toolChangeWritten) {
                        writer.write(predominantStrain.gCodeParser.getToolCode(toolNum) + "\n");
                        toolChangeWritten = true;
                    }

                    String safeName = predominantStrain == NgcStrain.router_971
                    ? part.partFile().getName().replaceAll("[()]", "")
                    : part.partFile().getName();
                    writer.write(openBracket + "Part: " + safeName + closeBracket + "\n");
                    writer.write(partHeader);
                    writer.write(partBody);
                }
            }

            // write the last footer
            writer.write(footer);

            if (predominantStrain == NgcStrain.router_971) {
                writer.write("%"); // No newline needed usually at very end
            }

            writer.flush();
            writer.close();

        } catch (IOException e) {
            System.err.println("Could not emit GCode into file");

            e.printStackTrace();
        }
    }

    public static boolean areToolTablesConsistent(List<NGCDocument> documents) {
        Map<Integer, ToolInfo> master = new HashMap<>();

        for (NGCDocument doc : documents) {
            for (var entry : doc.getToolTable().entrySet()) {
                // putIfAbsent returns the EXISTING value if present, or null if it was
                // just added. This does the lookup and insertion in a single
                // atomic-like step.
                ToolInfo existing = master.putIfAbsent(entry.getKey(), entry.getValue());

                // If existing is NOT null, it means we saw this tool before. Check for
                // conflict.
                if (existing != null && !existing.equals(entry.getValue())) {
                    return false; // Conflict found, stop immediately
                }
            }
        }
        return true;
    }

    public static Map<Integer, ToolInfo> getMasterToolTable(List<NGCDocument> documents) {
        Map<Integer, ToolInfo> master = new HashMap<>();

        for (NGCDocument doc : documents) {
            for (var entry : doc.getToolTable().entrySet()) {
                // putIfAbsent returns the EXISTING value if present, or null if it was
                // just added. This does the lookup and insertion in a single
                // atomic-like step.
                ToolInfo existing = master.putIfAbsent(entry.getKey(), entry.getValue());

                // If existing is NOT null, it means we saw this tool before. Check for
                // conflict.
                if (existing != null && !existing.equals(entry.getValue())) {
                    if (Screen.DebugMode)
                        throw new IllegalStateException(
                                "Consistency should be checked before getting master table.");
                }
            }
        }
        return master;
    }

    /**
     * Optimizes part order by trying every part as a starting point and running
     * Nearest Neighbor.
     * Returns the sequence with the minimum total travel distance.
     */
    private List<Part> getOptimizedPartOrder(List<Part> parts) {
        if (parts.isEmpty())
            return new ArrayList<>();
        if (parts.size() == 1)
            return new ArrayList<>(parts);

        List<Part> bestOrder = null;
        double minTotalDistance = Double.MAX_VALUE;

        // Try starting at every possible part to find the best chain
        for (int i = 0; i < parts.size(); i++) {
            List<Part> currentOrder = new ArrayList<>();
            List<Part> unvisited = new ArrayList<>(parts);

            // Pick start node
            Part current = unvisited.remove(i);
            currentOrder.add(current);

            double currentTotalDist = 0;

            // Run Nearest Neighbor from this start node
            while (!unvisited.isEmpty()) {
                Part nearest = null;
                double minDist = Double.MAX_VALUE;

                for (Part p : unvisited) {
                    // Calculate Euclidean distance
                    double dx = current.getCenterPoint().getCenterX() - p.getCenterPoint().getCenterX();
                    double dy = current.getCenterPoint().getCenterY() - p.getCenterPoint().getCenterY();
                    double dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist < minDist) {
                        minDist = dist;
                        nearest = p;
                    }
                }

                currentTotalDist += minDist;

                // Optimization: Abort if we already exceed the best path found so far
                if (currentTotalDist >= minTotalDistance) {
                    break;
                }

                current = nearest;
                currentOrder.add(nearest);
                unvisited.remove(nearest);
            }

            // Check if this full path is the new best
            if (unvisited.isEmpty() && currentTotalDist < minTotalDistance) {
                minTotalDistance = currentTotalDist;
                bestOrder = currentOrder;
            }
        }
        return bestOrder != null ? bestOrder : new ArrayList<>(parts);
    }

    public Cut getActiveCut() {
        return activeCut;
    }
}