package Parser.GCode;

import Display.ErrorDialog;
import Display.Screen;
import Display.WarningDialog;
import SheetHandler.Part;
import java.awt.geom.PathIterator;
import java.awt.geom.Point2D;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.StringReader;
import java.util.HashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class GCodeParserWinCNC implements GenericGCodeParser {
    public String parse(String gcodeLine, int lineNum, NGCDocument doc) {
        // split the line into multiple and parse all of them if it has >1 g
        if (gcodeLine.lastIndexOf('G') != gcodeLine.indexOf('G')) {
            String[] gcodeLines = gcodeLine.trim().split("G");
            for (String line : gcodeLines) {
                if (line.length() > 1) {
                    parse("G" + line, lineNum, doc);
                }
            }
        } else {
            if (gcodeLine.contains("S") || gcodeLine.contains("T")) {
                return gcodeLine;
            }
            HashMap<String, Double> attributes = new HashMap<>();
            for (String datum : gcodeLine.trim().split(" ")) {
                try {
                    double value = 0.0;
                    if (datum.substring(1).length() > 0)
                        value = Double.parseDouble(datum.substring(1));
                    attributes.put(datum.substring(0, 1), value);
                } catch (Exception r) {
                    r.printStackTrace();
                    new ErrorDialog(new IllegalArgumentException(), "Error: " + lineNum + ": " + gcodeLine);
                }
            }

            if (Screen.DebugMode)
                System.out.println(lineNum + ": " + gcodeLine + ":" + doc.getGcodeFile());
            doc.addGCodeAttributes(attributes);
        }
        return "";
    }

    public String getToolCode(int toolNum) {
        return "G53 Z\nM5\n[Tool " + toolNum + "]\n" + "T" + toolNum;
    }

    public String gCodeTransformClean(Part part, int toolNum, Point2D origin) {
        NGCDocument doc = part.getNgcDocument();
        String rawBody = doc.getGCodeForTool(toolNum);
        return !rawBody.trim().isEmpty() ? gCodeTransformClean(part, rawBody, origin) : "";
    }

    private String gCodeTransformClean(Part part, String gcode, Point2D origin) {
        return processPart(part, gcode, origin).getFullCode();
    }

    public String gCodeTransformClean(Part part, Point2D origin) {
        return gCodeTransformClean(part, getGCodeBody(part.getNgcDocument()), origin);
    }

    public String removeGCodeSpecialness(String gCode) {
        String newGCode = gCode.replaceAll("\\[.*\\]", "").trim() + "\n";
        return gCode.substring(0, gCode.indexOf(']') + 2)
                + newGCode
                + gCode.substring(gCode.lastIndexOf('['));
    }

    public String getGCodeHeader(NGCDocument doc) {
        String gCodeString = doc.getGCodeString();
        int endIndex = gCodeString.indexOf("G53");
        while (gCodeString.charAt(endIndex) != '\n') {
            endIndex++;
        }
        String header = gCodeString.substring(0, endIndex + 1);
        return "[START HEADER]\n" + header + "[END HEADER]\n";
    }

    public String getGCodeBody(NGCDocument doc) {
        String gCodeString = doc.getGCodeString();
        int endIndex = gCodeString.indexOf("G53");
        while (gCodeString.charAt(endIndex) != '\n') {
            endIndex++;
        }
        // Regex: Find 'G53' followed by anything (except newline) then 'Z'
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("G53[^\\n]*Z").matcher(gCodeString);

        int i = -1;
        while (m.find())
            i = m.start(); // Loop finds the LAST matching index

        // Fallback: If no "G53...Z" line exists, grab the last G53 of any kind
        if (i == -1)
            i = gCodeString.lastIndexOf("G53");
        String body = gCodeString.substring(endIndex + 1, i);
        return "[START BODY]\n" + body + "[END BODY]\n";
    }

    public String getGCodeFooter(NGCDocument doc) {
        String s = doc.getGCodeString();

        // Regex: Find 'G53' followed by anything (except newline) then 'Z'
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("G53[^\\n]*Z").matcher(s);

        int i = -1;
        while (m.find())
            i = m.start(); // Loop finds the LAST matching index

        // Fallback: If no "G53...Z" line exists, grab the last G53 of any kind
        if (i == -1)
            i = s.lastIndexOf("G53");

        return "[START FOOTER]\n" + (i != -1 ? s.substring(i) : "") + "[END FOOTER]\n";
    }

    public void addGCodeAttributes(HashMap<String, Double> attributes, NGCDocument doc) {
        // i and j are always relative
        doc.setIsRelativeArc(true);
        // set g to the last thing if theres no g
        if (!attributes.containsKey("G")) {
            attributes.put("G", doc.getPreviousAttributes().getOrDefault("G", 0.0));
        }

        // if not in inches, modify distance values
        if (!doc.isInchesMode()) {
            if (attributes.containsKey("X")) {
                attributes.put("X", attributes.get("X") / 25.4);
            }
            if (attributes.containsKey("Y")) {
                attributes.put("Y", attributes.get("Y") / 25.4);
            }
            if (attributes.containsKey("I")) {
                attributes.put("I", attributes.get("I") / 25.4);
            }
            if (attributes.containsKey("J")) {
                attributes.put("J", attributes.get("J") / 25.4);
            }
            if (attributes.containsKey("Z")) {
                attributes.put("Z", attributes.get("Z") / 25.4);
            }
        }

        // if it's a movement, ignore it if machine coords
        if (doc.usingMachineCoordinates() && attributes.get("G") >= 0 && attributes.get("G") <= 3) {
            doc.setUsingMachineCoordinates(false);
            return;
        }

        if (Screen.DebugMode)
            System.out.println(doc.getRelativity());

        boolean XHasChanged = attributes.containsKey("X");
        boolean YHasChanged = attributes.containsKey("Y");
        boolean XandYHasChanged = XHasChanged || YHasChanged;

        if (!XHasChanged) {
            attributes.put(
                    "X", doc.getRelativity() ? 0 : doc.getPreviousAttributes().getOrDefault("X", 0.0));
        }
        if (!YHasChanged) {
            attributes.put(
                    "Y", doc.getRelativity() ? 0 : doc.getPreviousAttributes().getOrDefault("Y", 0.0));
        }

        if (!attributes.containsKey("Z")) {
            attributes.put(
                    "Z", doc.getRelativity() ? 0 : doc.getPreviousAttributes().getOrDefault("Z", 0.0));
        }
        // Note: I and J are only modal on some router contollers. This code is
        // likely not necessary
        if (!attributes.containsKey("I")) {
            attributes.put(
                    "I", doc.getRelativityArc() ? 0 : doc.getPreviousAttributes().getOrDefault("I", 0.0));
        }
        if (!attributes.containsKey("J")) {
            attributes.put(
                    "J", doc.getRelativityArc() ? 0 : doc.getPreviousAttributes().getOrDefault("J", 0.0));
        }

        if (Screen.DebugMode) {
            System.out.println(attributes);
            System.out.println("xandy: " + XandYHasChanged);
            System.out.println("x: " + XHasChanged);
            System.out.println("y: " + YHasChanged);
        }

        switch ((int) attributes.get("G").doubleValue()) {
            case 0 -> {
                if (doc.getRelativity()) {
                    if (attributes.get("Z") + doc.getCurrentPointr().getZ() > 0
                            && doc.getCurrentPath2D().getPathIteratorType().stream()
                                    .anyMatch(e -> e != PathIterator.SEG_MOVETO)) {
                        doc.newPath2D();
                    }
                    if (XandYHasChanged) {
                        doc.getCurrentPath2D().moveToRelative(attributes.get("X"), -attributes.get("Y"));
                    }
                    doc.getCurrentPath2D().setZRelative(attributes.get("Z"));
                } else {
                    if (attributes.get("Z") > 0
                            && doc.getCurrentPath2D().getPathIteratorType().stream()
                                    .anyMatch(e -> e != PathIterator.SEG_MOVETO)) {
                        doc.newPath2D();
                    }
                    if (XandYHasChanged) {
                        doc.getCurrentPath2D().moveTo(attributes.get("X"), -attributes.get("Y"));
                    }
                    doc.getCurrentPath2D().setZ(attributes.get("Z"));
                    doc.getCurrentPath2D().setRelative(attributes.get("X"), -attributes.get("Y"));
                }
            }
            case 1 -> {
                if (doc.getRelativity()) {
                    if (XandYHasChanged)
                        doc.getCurrentPath2D().lineToRelative(attributes.get("X"), -attributes.get("Y"));
                    doc.getCurrentPath2D().setZRelative(attributes.get("Z"));
                } else {
                    if (XandYHasChanged)
                        doc.getCurrentPath2D().lineTo(attributes.get("X"), -attributes.get("Y"));
                    doc.getCurrentPath2D().setZ(attributes.get("Z"));
                    doc.getCurrentPath2D().setRelative(attributes.get("X"), -attributes.get("Y"));
                }
            }
            case 2, 3 -> {
                // only does arcs in XY plane
                double x = attributes.get("X");
                double y = -attributes.get("Y");
                double i = attributes.get("I");
                double j = -attributes.get("J");
                doc.getCurrentPath2D()
                        .arcTo(
                                i,
                                j,
                                x,
                                y,
                                attributes.get("G") == 2 ? -1 : 1,
                                doc.getRelativity(),
                                doc.getRelativityArc());
                if (doc.getRelativity()) {
                    doc.getCurrentPath2D().setZRelative(attributes.get("Z"));
                } else {
                    doc.getCurrentPath2D().setZ(attributes.get("Z"));
                }
            }
            case 4 -> {
                // dwell aka do nothing
                attributes.remove("X");
            }
            case 20 -> {
                doc.setInchesMode(true);
            }
            case 21 -> {
                doc.setInchesMode(false);
            }
            case 40 -> {
                doc.setCutterCompMode(0);
            }
            case 41 -> {
                doc.setCutterCompMode(1);
            }
            case 42 -> {
                doc.setCutterCompMode(2);
            }
            case 53 -> {
                // move in machine coordinates directly, do nothing
            }
            case 54, 55, 56, 57, 58, 59 -> {
                // WCS Offset, not set
                new WarningDialog(
                        new IllegalArgumentException(),
                        "WCS are not innately supported. Please only "
                                + "allow this if you know what you're doing.(justin)",
                        () -> {
                        });
            }
            case 80 -> {
                // end drill cycle, do nothing
            }
            case 81, 82, 83 -> {
                // drill cycle
                // just make a dot i give up
                doc.getCurrentPath2D().moveTo(attributes.get("X"), -attributes.get("Y"));
                doc.getCurrentPath2D().lineTo(attributes.get("X"), -attributes.get("Y"));
            }
            case 90 -> {
                if (attributes.get("G") == 90) {
                    // absolute distance mode
                    doc.setIsRelative(false);
                } else {
                    throw new UnknownGCodeError("Attributes " + attributes + "Not accepted GCode");
                }
            }
            case 91 -> {
                throw new UnknownGCodeError("G91 makes me sad");
            }
            default -> {
                throw new UnknownGCodeError("Attributes " + attributes + "Not accepted GCode");
            }
        }

        doc.setPreviousAttributes(attributes);
    }

    // 1. ADD THIS INNER CLASS (Container for the data)
    public static class ProcessedPart {
        public String header = "";
        public String body = "";
        public String startSpeed = null;
        public String endSpeed = null;

        public String getFullCode() {
            return header + body;
        }
    }

    // ... existing parse() and getToolCode() methods ...

    // 2. RENAME/REPLACE THE MAIN TRANSFORMATION LOGIC
    // This now returns the object instead of just a String
    public ProcessedPart processPart(Part part, String gcode, Point2D origin) {
        ProcessedPart result = new ProcessedPart();
        StringBuilder headerBuilder = new StringBuilder();
        StringBuilder bodyBuilder = new StringBuilder();

        // --- Math Setup ---
        double offX = (origin == null) ? 0 : origin.getX();
        double offY = (origin == null) ? 0 : origin.getY();
        final double dx = part.getX() - offX;
        final double dy = part.getY() - offY;
        final double rot = part.getRot();
        final double cos = Math.cos(rot);
        final double sin = Math.sin(rot);

        int lastGMode = 0;
        double stateX = 0, stateY = 0;
        boolean motionStarted = false;

        // Add 'S' to regex to capture Speed
        Pattern AXIS_PATTERN = Pattern.compile("(?i)([XYIJZRFSM])\\s*(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))");

        try (BufferedReader reader = new BufferedReader(new StringReader(gcode))) {
            String line;
            while ((line = reader.readLine()) != null) {
                String trimmed = line.trim();
                String commandPart = trimmed;
                String commentPart = "";

                if (trimmed.contains("[")) {
                    int idx = trimmed.indexOf("[");
                    commandPart = trimmed.substring(0, idx).trim();
                    commentPart = trimmed.substring(idx);
                }

                // Empty lines or G4 (Dwell) go to Header/Body based on motion status
                if (commandPart.isEmpty() || commandPart.toUpperCase().contains("G4")) {
                    (motionStarted ? bodyBuilder : headerBuilder).append(trimmed).append('\n');
                    continue;
                }

                // Identify Motion
                String gCommand = "";
                if (commandPart.toUpperCase().contains("G0")) {
                    lastGMode = 0;
                    gCommand = "G0";
                } else if (commandPart.toUpperCase().contains("G1")) {
                    lastGMode = 1;
                    gCommand = "G1";
                } else if (commandPart.toUpperCase().contains("G2")) {
                    lastGMode = 2;
                    gCommand = "G2";
                } else if (commandPart.toUpperCase().contains("G3")) {
                    lastGMode = 3;
                    gCommand = "G3";
                }

                // Parse Params
                double cX = 0, cY = 0, cZ = 0, cI = 0, cJ = 0, cF = 0, cS = 0;
                boolean hX = false, hY = false, hZ = false, hI = false, hJ = false, hF = false, hS = false;

                Matcher m = AXIS_PATTERN.matcher(commandPart);
                while (m.find()) {
                    String axis = m.group(1).toUpperCase();
                    double val = Double.parseDouble(m.group(2));
                    switch (axis) {
                        case "X" -> {
                            cX = val;
                            hX = true;
                        }
                        case "Y" -> {
                            cY = val;
                            hY = true;
                        }
                        case "Z" -> {
                            cZ = val;
                            hZ = true;
                        }
                        case "I" -> {
                            cI = val;
                            hI = true;
                        }
                        case "J" -> {
                            cJ = val;
                            hJ = true;
                        }
                        case "F" -> {
                            cF = val;
                            hF = true;
                        }
                        case "S" -> {
                            cS = val;
                            hS = true;
                        }
                    }
                }

                // Track Speed
                if (hS) {
                    String sVal = String.valueOf((int) cS);
                    if (result.startSpeed == null)
                        result.startSpeed = sVal;
                    result.endSpeed = sVal;
                }

                // Detect Motion Start (Coordinates or G-moves, ignoring setup lines like S or
                // M)
                if (!motionStarted && (!gCommand.isEmpty() || hX || hY || hZ)) {
                    motionStarted = true;
                }

                // Pass-through non-motion lines
                if (!hX && !hY && !hZ && !hI && !hJ && !hF) {
                    (motionStarted ? bodyBuilder : headerBuilder).append(trimmed).append('\n');
                    continue;
                }

                // Transform
                if (hX)
                    stateX = cX;
                if (hY)
                    stateY = cY;

                double xRot = stateX * cos - stateY * sin;
                double yRot = stateX * sin + stateY * cos;
                double xFinal = xRot + dx;
                double yFinal = yRot + dy;
                double iRot = cI * cos - cJ * sin;
                double jRot = cI * sin + cJ * cos;

                // Reconstruct
                StringBuilder sb = new StringBuilder();
                String extras = commandPart
                        .replaceAll("(?i)([XYIJZRFSMG])\\s*(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))", "")
                        .trim();

                if (!gCommand.isEmpty())
                    sb.append(gCommand);
                if (!extras.isEmpty())
                    sb.append(" ").append(extras);

                if (hX || hY)
                    sb.append(String.format(" X%.4f Y%.4f", xFinal, yFinal));
                if (hZ)
                    sb.append(String.format(" Z%.4f", cZ));
                if (hI || hJ)
                    sb.append(String.format(" I%.4f J%.4f", iRot, jRot));
                if (hF)
                    sb.append(String.format(" F%.1f", cF));
                if (hS)
                    sb.append(String.format(" S%d", (int) cS));

                if (!commentPart.isEmpty())
                    sb.append(" ").append(commentPart);
                sb.append('\n');

                (motionStarted ? bodyBuilder : headerBuilder).append(sb.toString());
            }
        } catch (IOException e) {
            e.printStackTrace();
        }

        result.header = headerBuilder.toString().trim();
        if (!result.header.isEmpty()) {
            result.header += "\n";
        }
        result.body = bodyBuilder.toString().trim();
        if (!result.body.isEmpty()) {
            result.body += "\n";
        }
        if (result.endSpeed == null && result.startSpeed != null)
            result.endSpeed = result.startSpeed;

        return result;
    }
}