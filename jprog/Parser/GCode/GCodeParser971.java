package Parser.GCode;

import Display.ErrorDialog;
import Display.Screen;
import SheetHandler.Part;
import java.awt.geom.PathIterator;
import java.awt.geom.Point2D;
import java.util.HashMap;

public class GCodeParser971 implements GenericGCodeParser {
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
            HashMap<String, Double> attributes = new HashMap<>();
            for (String datum : gcodeLine.trim().split(" ")) {
                try {
                    attributes.put(datum.substring(0, 1), Double.parseDouble(datum.substring(1)));
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
        return "(Tool " + toolNum + ")\n" + "T" + toolNum + " M6";
    }

    private String gCodeTranslateTo(Part part, Point2D origin) {
        double offX = (origin == null) ? 0 : origin.getX();
        double offY = (origin == null) ? 0 : origin.getY();

        double x = part.getX() - offX;
        double y = part.getY() - offY;
        double rot = part.getRot();

        return String.format(
                "G10 L2 P9 X[#5221+%f] Y[#5222+%f] Z[#5223] R%f\nG59.3\n", x, y, Math.toDegrees(rot));
    }

    public String gCodeTransformClean(Part part, int toolNum, Point2D origin) {
        throw new UnsupportedOperationException("This router hath no tool changer.");
    }

    public String gCodeTransformClean(Part part, Point2D origin) {
        NGCDocument doc = part.getNgcDocument();

        return "\n" + gCodeTranslateTo(part, origin) + getGCodeBody(doc).replaceAll(".*G54.*\\R?", "");
    }

    public String removeGCodeSpecialness(String gCode) {
        String newGCode = gCode.replaceAll("\\(.*\\)", "").trim() + "\n";
        newGCode = newGCode.replaceAll("\\n+", "\n").trim();
        return gCode.substring(0, gCode.indexOf(')') + 2)
                + newGCode
                + '\n'
                + gCode.substring(gCode.lastIndexOf('('));
    }

    public String getGCodeHeader(NGCDocument doc) {
        String gCodeString = doc.getGCodeString();
        int endIndex = gCodeString.indexOf("G53");
        while (gCodeString.charAt(endIndex) != '\n') {
            endIndex++;
        }
        String header = gCodeString.substring(gCodeString.indexOf('%') + 1, endIndex + 1);
        return "(START HEADER)\n" + header + "(END HEADER)\n";
    }

    public String getGCodeBody(NGCDocument doc) {
        String gCodeString = doc.getGCodeString();
        int endIndex = gCodeString.indexOf("G53");
        while (gCodeString.charAt(endIndex) != '\n') {
            endIndex++;
        }
        String body = gCodeString.substring(endIndex + 1, gCodeString.lastIndexOf("G53"));
        return "(START BODY)\n" + body + "(END BODY)\n";
    }

    public String getGCodeFooter(NGCDocument doc) {
        String gCodeString = doc.getGCodeString();
        String footer = gCodeString.substring(gCodeString.lastIndexOf("G53"), gCodeString.lastIndexOf('%'));
        return "(START FOOTER)\n" + footer + "\n(END FOOTER)\n";
    }

    public void addGCodeAttributes(HashMap<String, Double> attributes, NGCDocument doc) {
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
                if (doc.getCurrentAxisPlane() == 17) {
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
                } else {
                    if (doc.getRelativity()) {
                        doc.getCurrentPath2D().lineToRelative(attributes.get("X"), -attributes.get("Y"));
                        doc.getCurrentPath2D().setZRelative(attributes.get("Z"));
                    } else {
                        doc.getCurrentPath2D().lineTo(attributes.get("X"), -attributes.get("Y"));
                        doc.getCurrentPath2D().setZ(attributes.get("Z"));
                        doc.getCurrentPath2D().setRelative(attributes.get("X"), -attributes.get("Y"));
                    }
                }
                if (doc.getRelativity()) {
                    doc.getCurrentPath2D().setZRelative(attributes.get("Z"));
                } else {
                    doc.getCurrentPath2D().setZ(attributes.get("Z"));
                }
            }
            case 4 -> {
                // dwell aka do nothing
            }
            case 10 -> {
                // WCS Offset Select
            }
            case 17, 18, 19 -> {
                doc.setCurrentAxisPlane((int) attributes.get("G").doubleValue()); // sets axis planes
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
                if (attributes.containsKey("D"))
                    doc.setToolOffset(new ToolInfo(attributes.get("D") / 2.0));
            }
            case 42 -> {
                doc.setCutterCompMode(2);
                if (attributes.containsKey("D"))
                    doc.setToolOffset(new ToolInfo(attributes.get("D") / 2.0));
            }
            case 43 -> {
                // calls which tool length offset is used(TODO fix complexities)
            }
            case 53 -> {
                // Move In Machine Coordinates - ignore next move command
                doc.setUsingMachineCoordinates(true);
            }
            case 54, 55, 56, 57, 58, 59 -> {
                // WCS Offset(Do nothing for NOW TODO fix this)
            }
            case 64 -> {
                // do Nothing(Path Blending??!!??)
            }
            case 80 -> {
                // turn off canned cycle, does nothing???
            }
            case 81, 82, 83 -> {
                // canned cycles
                // just make a dot i give up
                doc.getCurrentPath2D().moveTo(attributes.get("X"), -attributes.get("Y"));
                doc.getCurrentPath2D().lineTo(attributes.get("X"), -attributes.get("Y"));
            }
            case 90 -> {
                if (attributes.get("G") == 90) {
                    // absolute distance mode
                    doc.setIsRelative(false);
                } else if (attributes.get("G") == 90.1) {
                    // absolute arc mode
                    doc.setIsRelativeArc(false);
                } else {
                    throw new UnknownGCodeError("Attributes " + attributes + "Not accepted GCode");
                }
            }
            case 91 -> {
                if (attributes.get("G") == 91) {
                    // incremental distance mode
                    doc.setIsRelative(true);
                } else if (attributes.get("G") == 91.1) {
                    doc.setIsRelativeArc(true);
                } else {
                    throw new UnknownGCodeError("Attributes " + attributes + "Not accepted GCode");
                }
            }
            case 94 -> {
                // do Nothing(Feed rate change)
            }
            case 98, 99 -> {
                // idk
            }
            default -> {
                throw new UnknownGCodeError("Attributes " + attributes + "Not accepted GCode");
            }
        }

        doc.setPreviousAttributes(attributes);
    }
}