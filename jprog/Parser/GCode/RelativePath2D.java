package Parser.GCode;

import Display.Screen;
import java.awt.geom.Path2D;
import java.awt.geom.PathIterator;
import java.awt.geom.Point2D;
import java.util.ArrayList;
import java.util.Arrays;

/**
 * Defines a geometric path with relative coordinates and arcs possible
 *
 * @see Path2D
 * @see Path2D.Double
 */
public class RelativePath2D extends Path2D.Double {
    public Point3D getCurrentPoint3D() {
        if (getCurrentPoint() == null) {
            return null;
        }
        return new Point3D(getCurrentPoint().getX(), getCurrentPoint().getY(), z);
    }

    public ArrayList<Integer> getPathIteratorType() {
        ArrayList<Integer> output = new ArrayList<>();
        PathIterator path = getPathIterator(null);
        while (!path.isDone()) {
            output.add(path.currentSegment(new double[6]));
            path.next();
        }
        return output;
    }

    private double z;
    private double xP, yP;
    private boolean offsetLeft = false;
    private boolean offsetRight = false;

    public void setZ(double z) {
        this.z = z;
    }

    public void setZRelative(double deltaZ) {
        z += deltaZ;
    }

    /**
     * Adds an arc segment, defined by 2 points, by drawing an arc that intersects
     * {@code (x2,y2)},
     * using the specified point {@code (x1,y2)}
     *
     * @param x1            the X-coordinate of the center of the arc
     * @param y1            the Y-coordinate of the center of the arc
     * @param x2            the X-coordinate of the final end point
     * @param y2            the Y-coordinate of the final end point
     * @param direction     -1 = clockwise, 0 = nothing, 1 = counterclockwise,
     *                      throws
     * @param isRelative    whether or not x2 and y2 are relative
     * @param isRelativeArc whether or not x1 and y1 are relative
     */
    public void arcTo(
            double x1,
            double y1,
            double x2,
            double y2,
            int direction,
            boolean isRelative,
            boolean isRelativeArc) {
        if (direction < -1 || direction > 1) {
            throw new IllegalArgumentException("Direction: " + direction + " is not in the range -1, 1");
        }

        direction *= -1;
        double startX = getCurrentPoint().getX();
        double startY = getCurrentPoint().getY();

        double centerX = x1;
        double centerY = y1;

        if (isRelativeArc) {
            centerX += startX;
            centerY += startY;
        }

        double endX = x2;
        double endY = y2;

        if (isRelative) {
            endX += startX;
            endY += startY;
        }

        if (Screen.DebugMode) {
            System.out.printf("Arguments: x1: %f, y1: %f, x2: %f, y2: %f%n", x1, y1, x2, y2);
            System.out.printf(
                    "Arcing from %f, %f to %f, %f around %f, %f%n",
                    startX, startY, endX, endY, centerX, centerY);
        }

        double startingAngle = Math.atan((startY - centerY) / (startX - centerX));
        if (startX - centerX < 0) {
            startingAngle += Math.PI;
        }

        double endingAngle = Math.atan((endY - centerY) / (endX - centerX));
        if (endX - centerX < 0) {
            endingAngle += Math.PI;
        }
        while (endingAngle * direction < startingAngle * direction) {
            endingAngle += Math.PI * 2 * direction;
        }

        double radius = Math.sqrt(
                (startX - centerX) * (startX - centerX) + (startY - centerY) * (startY - centerY));
        double radius2 = Math.sqrt((endX - centerX) * (endX - centerX) + (endY - centerY) * (endY - centerY));

        if (Screen.DebugMode) {
            System.out.printf(
                    "Radius is %f, starting angle is %f, ending angle is %f%n",
                    radius, startingAngle, endingAngle);
        }

        if (Math.abs(radius - radius2) > 0.05
                || (Math.abs(radius - radius2) > 0.05
                        && Math.abs(radius - radius2) > (radius + radius2) / 2 * 0.001)) {
            throw new IllegalGCodeError(
                    "Arc is not defined to have a self-similar radius:\nr1: " + radius + "\nr2: " + radius2);
        } else {
            radius = radius / 2 + radius2 / 2;
            double angle = startingAngle;

            double incrVal = Math.abs(startingAngle - endingAngle) / 10;

            while (angle * direction < endingAngle * direction) {
                angle += incrVal * direction;
                if (angle * direction < endingAngle * direction)
                    lineTo(centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle));
            }
        }
        lineTo(endX, endY);
        setRelative(endX, endY);
    }

    public void setRelative(double x, double y) {
        xP = x;
        yP = y;
    }

    /**
     * Adds a point to the path by moving to the specified, relative coordinates
     * specified in double
     * precision.
     *
     * @param x the specified X coordinate relative to the previous point
     * @param y the specified Y coordinate relative to the previous point
     */
    public void moveToRelative(double x, double y) {
        moveTo(x + xP, y + yP);
        setRelative(x, y);
    }

    /**
     * Adds a point to the path by drawing a straight line from the current
     * coordinates to the new
     * specified, relative coordinates specified in double precision.
     *
     * @param x the specified X coordinate relative to the previous point
     * @param y the specified Y coordinate relative to the previous point
     */
    public void lineToRelative(double x, double y) {
        lineTo(x + xP, y + yP);
        setRelative(x, y);
    }

    /**
     * Adds a curved segment, defined by two new points, relative to the previous
     * point, to the path
     * by drawing a Quadratic curve that intersects both the current coordinates and
     * the specified
     * coordinates {@code (x2,y2)}, using the specified point {@code (x1,y1)} as a
     * quadratic
     * parametric control point. Both points are relative to the previous point All
     * coordinates are
     * specified in double precision.
     *
     * @param x1 the X coordinate of the quadratic control point relative to the
     *           previous point
     * @param y1 the Y coordinate of the quadratic control point relative to the
     *           previous point
     * @param x2 the X coordinate of the final end point relative to the previous
     *           point
     * @param y2 the Y coordinate of the final end point relative to the previous
     *           point
     */
    @Deprecated
    public void quadToRelative(double x1, double y1, double x2, double y2) {
        quadTo(x1 + xP, y1 + yP, x2 + xP, y2 + yP);
        setRelative(x2, y2);
    }

    /**
     * Adds a curved segment, defined by three new points, to the path by drawing a
     * B&eacute;zier
     * curve that intersects both the current coordinates and the specified
     * coordinates {@code
     * (x3,y3)}, using the specified points {@code (x1,y1)} and {@code (x2,y2)} as
     * B&eacute;zier
     * control points. All points are relative to the previous point All coordinates
     * are specified in
     * double precision.
     *
     * @param x1 the X coordinate of the first B&eacute;zier control point relative
     *           to the previous
     *           point
     * @param y1 the Y coordinate of the first B&eacute;zier control point relative
     *           to the previous
     *           point
     * @param x2 the X coordinate of the second B&eacute;zier control point relative
     *           to the previous
     *           point
     * @param y2 the Y coordinate of the second B&eacute;zier control point relative
     *           to the previous
     *           point
     * @param x3 the X coordinate of the final end point relative to the previous
     *           point
     * @param y3 the Y coordinate of the final end point relative to the previous
     *           point
     */
    @Deprecated
    public void curveToRelative(double x1, double y1, double x2, double y2, double x3, double y3) {
        curveTo(x1 + xP, y1 + yP, x2 + xP, y2 + yP, x3 + xP, y3 + yP);
        setRelative(x3, y3);
    }

    public void offsetRight() {
        if (!offsetLeft) {
            offsetRight = true;
        } else {
            throw new IllegalArgumentException("cannot offset in two directions at once");
        }
    }

    public void offsetLeft() {
        if (!offsetRight) {
            offsetLeft = true;
        } else {
            throw new IllegalArgumentException("cannot offset in two directions at once");
        }
    }

    public RelativePath2D getOffsetInstance2(double offset) {
        if (!offsetLeft && !offsetRight) {
            return this;
        }

        PathIterator holder = getPathIterator(null);
        // stores the start and endpoints of the lines
        ArrayList<ArrayList<double[]>> paths = new ArrayList<>();

        while (!holder.isDone()) {
            double[] pointLocation = new double[6];
            int type = holder.currentSegment(pointLocation);
            holder.next();
            if (type == PathIterator.SEG_MOVETO) {
                // remove the last line with a trailing thing
                if (paths.size() > 0)
                    paths.get(paths.size() - 1).remove(paths.get(paths.size() - 1).size() - 1);
                ArrayList<double[]> currentPath = new ArrayList<>();
                paths.add(currentPath);
                currentPath.add(new double[4]);
                currentPath.get(0)[0] = pointLocation[0];
                currentPath.get(0)[1] = pointLocation[1];
            } else if (type == PathIterator.SEG_LINETO) {
                ArrayList<double[]> currentPath = paths.get(paths.size() - 1);
                currentPath.get(currentPath.size() - 1)[2] = pointLocation[0];
                currentPath.get(currentPath.size() - 1)[3] = pointLocation[1];
                currentPath.add(new double[4]);
                currentPath.get(currentPath.size() - 1)[0] = pointLocation[0];
                currentPath.get(currentPath.size() - 1)[1] = pointLocation[1];
            }
        }
        paths.get(paths.size() - 1).remove(paths.get(paths.size() - 1).size() - 1);
        // remove empty paths
        paths.removeIf(e -> e.size() == 0);
        // remove lines that are just points
        paths.forEach(e -> e.removeIf(e2 -> e2[0] == e2[2] && e2[1] == e2[3]));

        // offset lines to the left/right
        // offset is negative to the left, positive to the right
        if (offsetLeft) {
            offset = -offset;
        } else if (!offsetRight) {
            offset = 0;
        }

        // move points in normal direction to line
        for (ArrayList<double[]> lines : paths) {
            for (double[] line : lines) {
                // calculate offset
                double pOffsetX = line[2] - line[0];
                double pOffsetY = line[3] - line[1];

                // normalize
                double mag = Math.sqrt(pOffsetX * pOffsetX + pOffsetY * pOffsetY);
                pOffsetX /= mag;
                pOffsetY /= mag;

                // rotate 90 degrees to the right
                double temp = pOffsetX;
                pOffsetX = pOffsetY;
                pOffsetY = -temp;

                // multiply by offset
                pOffsetX *= offset;
                pOffsetY *= offset;

                // move points
                line[0] += pOffsetX;
                line[1] += pOffsetY;
                line[2] += pOffsetX;
                line[3] += pOffsetY;
            }
        }

        // extend/retract lines to each other
        // i refers to the ith point in the line (0-indexed)
        for (ArrayList<double[]> lines : paths) {
            for (int i = 1; i < lines.size(); i++) {
                // fine I'll find slopes
                double[] line1 = lines.get(i - 1);
                double[] line2 = lines.get(i);

                if (line1[0] == line1[2]) {
                    // line 1 is vertical
                    if (line2[0] == line2[2]) {
                        // the lines are parallel, leave the point where it is
                        continue;
                    }

                    double line2Slope = (line2[1] - line2[3]) / (line2[0] - line2[2]);
                    double line2Offset = line2[1] - line2[0] * line2Slope;

                    // get the intersection point
                    double pX = line1[0];
                    double pY = line2Slope * pX + line2Offset;

                    // actually set the line positions
                    line1[2] = pX;
                    line1[3] = pY;
                    line2[0] = pX;
                    line2[1] = pY;
                    continue;
                }
                if (line2[0] == line2[2]) {
                    // line 2 is vertical
                    double line1Slope = (line1[1] - line1[3]) / (line1[0] - line1[2]);
                    double line1Offset = line1[1] - line1[0] * line1Slope;

                    // get the intersection point
                    double pX = line1[0];
                    double pY = line1Slope * pX + line1Offset;

                    // actually set the line positions
                    line1[2] = pX;
                    line1[3] = pY;
                    line2[0] = pX;
                    line2[1] = pY;
                    continue;
                }
                double line1Slope = (line1[1] - line1[3]) / (line1[0] - line1[2]);
                double line1Offset = line1[1] - line1[0] * line1Slope;
                double line2Slope = (line2[1] - line2[3]) / (line2[0] - line2[2]);
                double line2Offset = line2[1] - line2[0] * line2Slope;

                if (line1Slope == line2Slope) {
                    // the lines are parallel, leave the point where it is
                    continue;
                }

                // get the intersection point
                double pX = (line2Offset - line1Offset) / (line1Slope - line2Slope);
                double pY = line1Slope * pX + line1Offset;

                // print out the differences

                line1[2] = pX;
                line1[3] = pY;
                line2[0] = pX;
                line2[1] = pY;
            }
        }

        // create the new polygon
        RelativePath2D offsetPath = new RelativePath2D();
        for (ArrayList<double[]> lines : paths) {
            offsetPath.moveTo(lines.get(0)[0], lines.get(0)[1]);
            for (double[] line : lines) {
                offsetPath.lineTo(line[2], line[3]);
            }
        }

        return offsetPath;
    }

    /**
     * @param leftP
     * @param midP
     * @param rightP
     * @return returns normal slope of the middle of the subgradient of the point
     *         midP
     */
    private double getMidNormSlope(double[] leftP, double[] midP, double[] rightP) {
        return -2 / (getSlope(leftP, midP) + getSlope(midP, rightP));
    }

    /**
     * @param p1 first point
     * @param p2 second point
     * @return slope of the line that fits these two points
     */
    private double getSlope(double[] p1, double[] p2) {
        return (p2[1] - p1[1]) / (p2[0] - p1[0]);
    }

    @Override
    public String toString() {
        StringBuilder output = new StringBuilder("{RelativePath2D:\n");

        PathIterator path = getPathIterator(null);
        while (!path.isDone()) {
            double[] data = new double[6];
            int type = path.currentSegment(data);
            String typeString = switch (type) {
                case PathIterator.SEG_MOVETO -> "SEG_MOVETO";
                case PathIterator.SEG_LINETO -> "SEG_LINETO";
                case PathIterator.SEG_CLOSE -> "SEG_CLOSE";
                default -> "" + type;
            };
            output.append(typeString + ": " + Arrays.toString(trim(data)) + "\n");
            path.next();
        }
        output.append("}");

        return output.toString();
    }

    private double[] trim(double[] arr) {
        int nonZeroNum = 0;
        for (int i = 0; i < arr.length; i++) {
            if (arr[i] != 0) {
                nonZeroNum++;
            }
        }
        double[] output = new double[nonZeroNum];
        System.arraycopy(arr, 0, output, 0, nonZeroNum);
        return output;
    }
}

class Point3D extends Point2D.Double {
    private double z;

    public Point3D(double x, double y, double z) {
        super(x, y);
        this.z = z;
    }

    public double getZ() {
        return z;
    }

    public void setLocation(double x, double y, double z) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    @Override
    /**
     * Returns a {@code String} that represents the value of this {@code Point3D}.
     *
     * @return a string representation of this {@code Point3D}.
     */
    public String toString() {
        return "Point3D[" + x + ", " + y + ", " + z + "]";
    }
}
